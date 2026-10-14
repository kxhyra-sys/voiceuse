// VoiceUse web client: speech in, speech out, a live view of the browser Claude drives.

import { isEcho } from "./echo.js";

const $ = (id) => document.getElementById(id);
const els = {
  talk: $("talk"), talkText: $("talkText"), wave: $("wave"),
  view: $("view"), frame: $("frame"), viewEmpty: $("viewEmpty"),
  log: $("log"), logEmpty: $("logEmpty"),
  tabs: $("tabs"), url: $("url"), addr: $("addr"),
  typed: $("typed"), typedInput: $("typedInput"),
  settings: $("settings"), apiKey: $("apiKey"), keyHint: $("keyHint"), jevHint: $("jevHint"), model: $("model"), speak: $("speak"),
  voice: $("voice"), voiceHint: $("voiceHint"),
  sessions: $("sessions"), sessionList: $("sessionList"), sessionsEmpty: $("sessionsEmpty"),
};

const state = {
  phase: "idle",          // idle | listening | working | speaking
  hasKey: false,
  viewport: { width: 1280, height: 800 },
  control: false,         // the person has the live view's keyboard
  speakReplies: load("speak", true),
  voice: load("voice", null), // "kokoro:af_heart" or "browser:<name>"; null until the server says its default
  voices: [],             // natural voices the server offers
  voiceReady: false,
  lastSteps: null,        // <li> holding the current run's progress notes
  sessionId: load("current", null),
  synced: false,          // matched this page's session with the server's since connecting
  lastSpoken: null,       // { text, endedAt } of the reply read out last, to ignore it if the mic hears it
};

// How long after a reply ends the mic may still hear it (speaker latency, room echo).
const ECHO_WINDOW_MS = 15_000;
// Pause between the end of a spoken question and reopening the mic, so the tail of the reply has
// left the speakers (Bluetooth output lags by a few hundred milliseconds).
const REOPEN_DELAY_MS = 700;

// MARK: Socket

let ws;
let retry = 0;
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = "blob";
  ws.onopen = () => { retry = 0; };
  ws.onmessage = (event) => {
    if (event.data instanceof Blob) return showFrame(event.data);
    handle(JSON.parse(event.data));
  };
  ws.onclose = () => {
    state.synced = false;
    els.viewEmpty.hidden = false;
    els.viewEmpty.textContent = "Lost the connection to the VoiceUse server. Reconnecting…";
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}
const send = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

let frameURL = null;
function showFrame(blob) {
  const url = URL.createObjectURL(blob);
  els.frame.onload = () => { if (frameURL && frameURL !== url) URL.revokeObjectURL(frameURL); frameURL = url; };
  els.frame.src = url;
  els.viewEmpty.hidden = true;
}

function handle(msg) {
  switch (msg.type) {
    case "status": return applyStatus(msg);
    case "working":
      setPhase("working", "Thinking…");
      return;
    case "note":
      addStep(msg.text);
      if (state.phase === "working") setTalk("working", firstSentence(msg.text));
      return;
    case "action":
      addStep(cap(msg.text), "action");
      if (state.phase === "working") setTalk("working", `${cap(msg.text)}…`);
      return;
    case "reply":
      state.lastSteps = null;
      addEntry("claude", msg.text, true);
      return reply(msg.text, msg.expectsAnswer, msg.chunks);
    case "fast":
      state.lastSteps = null;
      if (msg.reset) {
        newSession();
        clearLog();
      }
      addEntry("step", msg.text, true);
      return setPhase("idle", msg.text);
    case "cleared":
      newSession();
      clearLog();
      addEntry("step", "The model changed, so this is a new conversation. The last one is in Sessions.");
      return;
    case "snapshot":
      if (msg.sessionId === state.sessionId) updateSession({ messages: msg.messages, tabs: msg.tabs, model: msg.model });
      return;
    case "resumed":
      setPhase("idle", "Picked up where you left off. Press Space and speak.");
      return;
    case "stopped":
      state.lastSteps = null;
      addEntry("step", "Stopped.", true);
      return setPhase("idle");
    case "error":
      state.lastSteps = null;
      addEntry("problem", msg.text, true);
      if (/api key/i.test(msg.text)) openSettings();
      setPhase("idle");
      return setTalk("problem", msg.text);
  }
}

function applyStatus(s) {
  state.hasKey = s.hasKey;
  state.viewport = s.viewport;
  if (!s.working && state.phase === "working") setPhase("idle");
  els.model.replaceChildren(...s.models.map((m) => new Option(m.name, m.id, false, m.id === s.model)));
  els.keyHint.textContent = s.hasKey
    ? "A key is saved. Paste a new one to replace it, or leave this empty to keep it."
    : "Saved in web/.env on this computer. Create one at console.anthropic.com.";
  els.jevHint.textContent = s.jev
    ? "Jev fast path is on: simple commands run without Claude."
    : "Jev fast path is off. Set TYPESAFE_API_KEY before npm start to turn it on.";
  renderTabs(s.tabs);
  state.voices = s.voices ?? [];
  state.voiceReady = !!s.voiceReady;
  state.voice ??= s.defaultVoice ? `kokoro:${s.defaultVoice}` : null;
  if (els.settings.open) renderVoices();
  saveTabsSoon(s.tabs);
  if (!state.synced) {
    state.synced = true;
    syncSession(s.sessionId);
  }
  if (!s.hasKey && !els.settings.open && !sessionStorage.getItem("askedKey")) {
    sessionStorage.setItem("askedKey", "1");
    openSettings();
  }
}

// MARK: Talk bar

function setPhase(phase, text) {
  state.phase = phase;
  els.view.dataset.working = String(phase === "working");
  const idle = recognitionSupported ? "Press Space and speak" : "Voice needs Chrome, Edge or Safari. Type below.";
  const label = text ?? { idle, listening: "Listening…", working: "Working…", speaking: "Speaking… press Space to skip" }[phase];
  setTalk(phase, label);
}
function setTalk(kind, text) {
  els.talk.dataset.state = kind;
  els.talkText.textContent = text;
}

els.talk.addEventListener("click", toggleTalk);

function toggleTalk() {
  switch (state.phase) {
    case "idle": return startListening();
    case "listening": return recognition?.stop();
    case "working": return send({ type: "stop" });
    case "speaking": stopSpeaking(); return setPhase("idle");
  }
}

function stopEverything() {
  recognition?.abort();
  stopSpeaking();
  if (state.phase === "working") send({ type: "stop" });
  setPhase("idle");
}

// MARK: Speech in

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognitionSupported = !!Recognition;
let recognition = null;

function startListening(echoRetries = 2) {
  if (!recognitionSupported) {
    els.typedInput.focus();
    return setTalk("problem", "Voice needs Chrome, Edge or Safari. Type below.");
  }
  stopSpeaking();
  recognition = new Recognition();
  recognition.lang = navigator.language || "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = "";
  let interim = "";

  recognition.onresult = (event) => {
    interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    setTalk("listening", (finalText + interim).trim() || "Listening…");
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      setTalk("problem", "Allow the microphone for this page, then try again.");
    } else if (event.error === "no-speech") {
      setTalk("idle", "Didn't catch anything. Press Space to try again.");
    } else if (event.error !== "aborted") {
      setTalk("problem", `Voice input stopped: ${event.error}.`);
    }
  };
  recognition.onend = () => {
    stopMeter();
    recognition = null;
    const text = (finalText || interim).trim();
    if (state.phase !== "listening") return;
    state.phase = "idle";
    if (text && isEcho(text, recentlySpoken())) {
      if (echoRetries > 0) {
        startListening(echoRetries - 1);
        return setTalk("listening", "That was my own voice. Go ahead…");
      }
      setPhase("idle");
      return setTalk("problem", "The mic keeps hearing my voice. Use headphones or turn the speakers down.");
    }
    if (text) heard(text);
    else if (els.talk.dataset.state === "listening") setPhase("idle");
  };

  setPhase("listening");
  recognition.start();
  startMeter();
}

function heard(text) {
  const plain = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
  if (["stop", "cancel", "never mind", "nevermind", "forget it"].includes(plain)) return stopEverything();
  if (["start over", "new conversation", "new task", "reset"].includes(plain)) return resetConversation();
  submit(text);
}

function submit(text) {
  if (!state.hasKey) return openSettings();
  addEntry("you", text, true);
  state.lastSteps = null;
  setPhase("working", "Thinking…");
  send({ type: "command", text, sessionId: state.sessionId });
}

// Mic level for the waveform while listening.
let meter = null;
async function startMeter() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (state.phase !== "listening") return stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    meter = { stream, ctx, analyser, raf: 0, history: [] };
    drawMeter();
  } catch {
    // No level meter; recognition still works.
  }
}
function stopMeter() {
  if (!meter) return;
  cancelAnimationFrame(meter.raf);
  meter.stream.getTracks().forEach((t) => t.stop());
  meter.ctx.close();
  meter = null;
}
function drawMeter() {
  if (!meter) return;
  const canvas = els.wave;
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const data = new Uint8Array(meter.analyser.fftSize);
  meter.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += ((v - 128) / 128) ** 2;
  const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
  meter.history.push(level);
  const bar = 4, gap = 3, count = Math.floor((w * 0.5) / (bar + gap));
  if (meter.history.length > count) meter.history.splice(0, meter.history.length - count);

  // Bars scroll in from the right half of the bar, newest at the edge.
  g.fillStyle = "rgb(255 255 255 / 0.55)";
  meter.history.forEach((lv, i) => {
    const x = w - 24 - (meter.history.length - i) * (bar + gap);
    const bh = Math.max(3, lv * (h - 22));
    g.beginPath();
    g.roundRect(x, (h - bh) / 2, bar, bh, 2);
    g.fill();
  });
  meter.raf = requestAnimationFrame(drawMeter);
}

// MARK: Speech out

// Replies are read in a natural voice the server makes on this computer (Kokoro), one chunk at a
// time so the first words play while the rest are made. The browser's own voices are the fallback.

let playback = null;

function speakOut(parts, voice, done) {
  stopSpeaking();
  const token = { cancelled: false, stopAudio: null };
  token.cancel = () => {
    token.cancelled = true;
    token.stopAudio?.();
    speechSynthesis.cancel();
  };
  playback = token;
  const finish = () => {
    if (playback !== token) return;
    playback = null;
    done();
  };
  const natural = voice?.startsWith("kokoro:") && state.voiceReady;
  if (!natural) return browserSpeak(parts.join(" "), voice?.startsWith("browser:") ? voice.slice(8) : null, finish);

  const id = voice.slice(7);
  const make = (text) => fetch("/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice: id }),
  }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`tts ${r.status}`))));

  (async () => {
    let next = make(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      let blob;
      try {
        blob = await next;
      } catch {
        // The natural voice failed: say the rest with the browser's voice.
        if (!token.cancelled) browserSpeak(parts.slice(i).join(" "), null, finish);
        return;
      }
      if (token.cancelled) return;
      if (i + 1 < parts.length) {
        next = make(parts[i + 1]);
        next.catch(() => {});
      }
      const url = URL.createObjectURL(blob);
      await new Promise((resolve) => {
        const audio = new Audio(url);
        token.stopAudio = () => { audio.pause(); resolve(); };
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
      if (token.cancelled) return;
    }
    finish();
  })();
}

function recentlySpoken() {
  const last = state.lastSpoken;
  if (!last) return null;
  return last.endedAt === null || Date.now() - last.endedAt < ECHO_WINDOW_MS ? last.text : null;
}

function stopSpeaking() {
  if (playback && state.lastSpoken?.endedAt === null) state.lastSpoken.endedAt = Date.now();
  playback?.cancel();
  playback = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function browserVoices() {
  if (!("speechSynthesis" in window)) return [];
  const base = (navigator.language || "en-US").toLowerCase().split("-")[0];
  const voices = speechSynthesis.getVoices();
  const same = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  return same.length ? same : voices;
}

function pickBrowserVoice(name) {
  const pool = browserVoices();
  const named = name && pool.find((v) => v.name === name);
  if (named) return named;
  const lang = (navigator.language || "en-US").toLowerCase();
  const good = /premium|enhanced|natural|neural|google|samantha|daniel|karen|anna/i;
  return pool.find((v) => v.lang.toLowerCase() === lang && good.test(v.name)) ?? pool.find((v) => good.test(v.name)) ?? pool[0];
}

function browserSpeak(text, name, done) {
  if (!("speechSynthesis" in window)) return done();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickBrowserVoice(name);
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
  utterance.rate = 1.05;
  utterance.onend = done;
  utterance.onerror = done;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function reply(text, expectsAnswer, parts) {
  const after = (spoke) => {
    if (state.phase === "speaking" || state.phase === "working") setPhase("idle");
    if (!expectsAnswer || !recognitionSupported) return setTalk("idle", text);
    if (!spoke) return startListening();
    setTalk("idle", text);
    setTimeout(() => { if (state.phase === "idle" && !recognition) startListening(); }, REOPEN_DELAY_MS);
  };
  if (!state.speakReplies) return after(false);
  setPhase("speaking");
  const spoken = { text, endedAt: null };
  state.lastSpoken = spoken;
  speakOut(parts?.length ? parts : [text], state.voice, () => {
    spoken.endedAt = Date.now();
    if (state.phase === "speaking") after(true);
  });
}

function renderVoices() {
  const natural = document.createElement("optgroup");
  natural.label = "Natural voices (made on this computer)";
  natural.append(...state.voices.map((v) => new Option(v.name, `kokoro:${v.id}`)));
  const browser = document.createElement("optgroup");
  browser.label = "Browser voices";
  browser.append(...browserVoices().map((v) => new Option(`${v.name} (${v.lang})`, `browser:${v.name}`)));
  const picked = els.voice.value || state.voice;
  els.voice.replaceChildren(...[natural, browser].filter((g) => g.childElementCount));
  if (picked && [...els.voice.options].some((o) => o.value === picked)) els.voice.value = picked;
  els.voiceHint.textContent = state.voiceReady
    ? "Natural voices run on this computer; nothing is sent anywhere."
    : "The natural voice is still loading (the first start downloads about 90 MB). Browser voices work meanwhile.";
}

$("tryVoice").addEventListener("click", () => {
  speakOut(["Hi! This is how I'll sound when I read my replies to you."], els.voice.value, () => {});
});

// Chrome loads voices lazily.
if ("speechSynthesis" in window) {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener("voiceschanged", () => { if (els.settings.open) renderVoices(); });
}

// MARK: Conversation log

function addEntry(kind, text, record = false) {
  if (record) remember(kind, text);
  els.logEmpty.hidden = true;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  els.log.append(li);
  li.scrollIntoView({ block: "end", behavior: "smooth" });
  return li;
}

function addStep(text, kind = "note") {
  if (!state.lastSteps) state.lastSteps = addEntry("step", "");
  const line = document.createElement("div");
  line.textContent = kind === "action" ? text : firstSentence(text, 160);
  state.lastSteps.append(line);
  // Keep the last few steps visible; the full list would drown the conversation.
  while (state.lastSteps.childElementCount > 6) state.lastSteps.firstElementChild.remove();
  state.lastSteps.scrollIntoView({ block: "end" });
}

function clearLog() {
  els.log.replaceChildren();
  els.logEmpty.hidden = false;
  state.lastSteps = null;
}

function resetConversation() {
  newSession();
  send({ type: "reset", sessionId: state.sessionId });
  clearLog();
  setPhase("idle", "New conversation. Press Space and speak.");
}
$("resetBtn").addEventListener("click", resetConversation);

// MARK: Typed requests

els.typed.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.typedInput.value.trim();
  if (!text || state.phase === "working") return;
  els.typedInput.value = "";
  stopSpeaking();
  submit(text);
});

// MARK: Tabs and address bar

function renderTabs(tabs) {
  els.tabs.replaceChildren(...tabs.map((tab) => {
    const b = document.createElement("button");
    b.className = "tab";
    b.title = tab.url;
    b.setAttribute("aria-current", String(!!tab.active));
    const label = document.createElement("span");
    label.textContent = tab.title === "(untitled)" ? hostOf(tab.url) || "New tab" : tab.title;
    const x = document.createElement("span");
    x.className = "x";
    x.setAttribute("role", "button");
    x.setAttribute("aria-label", "Close tab");
    x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.addEventListener("click", (e) => { e.stopPropagation(); send({ type: "input", kind: "closeTab", id: tab.tab_id }); });
    b.append(label, x);
    b.addEventListener("click", () => send({ type: "input", kind: "switchTab", id: tab.tab_id }));
    return b;
  }));
  const active = tabs.find((t) => t.active);
  if (active && document.activeElement !== els.url) els.url.value = active.url === "about:blank" ? "" : active.url;
}

els.addr.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = els.url.value.trim();
  if (url) send({ type: "input", kind: "navigate", url });
  els.url.blur();
});
$("back").addEventListener("click", () => send({ type: "input", kind: "back" }));
$("forward").addEventListener("click", () => send({ type: "input", kind: "forward" }));
$("reload").addEventListener("click", () => send({ type: "input", kind: "reload" }));
$("newTab").addEventListener("click", () => send({ type: "input", kind: "newTab" }));

// MARK: Live view: the person's mouse and keyboard

function viewPoint(e) {
  const r = els.frame.getBoundingClientRect();
  return {
    x: Math.round(((e.clientX - r.left) / r.width) * state.viewport.width),
    y: Math.round(((e.clientY - r.top) / r.height) * state.viewport.height),
  };
}

els.view.addEventListener("mousedown", (e) => {
  e.preventDefault();
  setControl(true);
  els.view.focus({ preventScroll: true });
});
els.view.addEventListener("click", (e) => {
  send({ type: "input", kind: "click", ...viewPoint(e), count: Math.min(e.detail || 1, 3) });
});
els.view.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  send({ type: "input", kind: "click", ...viewPoint(e), button: "right" });
});
let wheelAcc = { dx: 0, dy: 0, at: null };
els.view.addEventListener("wheel", (e) => {
  e.preventDefault();
  wheelAcc.dx += e.deltaX;
  wheelAcc.dy += e.deltaY;
  wheelAcc.at = viewPoint(e);
  if (wheelAcc.timer) return;
  wheelAcc.timer = setTimeout(() => {
    send({ type: "input", kind: "wheel", ...wheelAcc.at, dx: wheelAcc.dx, dy: wheelAcc.dy });
    wheelAcc = { dx: 0, dy: 0, at: null };
  }, 50);
}, { passive: false });

els.view.addEventListener("blur", () => setControl(false));
els.view.addEventListener("keydown", (e) => {
  if (!state.control) return;
  e.preventDefault();
  e.stopPropagation();
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.metaKey && "Meta", e.shiftKey && "Shift"].filter(Boolean);
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    send({ type: "input", kind: "type", text: e.key });
  } else if (!["Control", "Alt", "Meta", "Shift"].includes(e.key)) {
    const key = e.key === " " ? "Space" : e.key;
    send({ type: "input", kind: "key", key: [...mods, key].join("+") });
  }
});
els.view.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text");
  if (text) { e.preventDefault(); send({ type: "input", kind: "type", text }); }
});
function setControl(on) {
  state.control = on;
  els.view.dataset.control = String(on);
}

// MARK: Global keys

document.addEventListener("keydown", (e) => {
  if (state.control || els.settings.open || els.sessions.open) return;
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === "Escape") {
    if (typing) e.target.blur();
    return stopEverything();
  }
  if (typing || e.repeat) return;
  if (e.code === "Space" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    toggleTalk();
  }
});

// MARK: Settings

function openSettings() {
  els.apiKey.value = "";
  els.speak.checked = state.speakReplies;
  renderVoices();
  if (!els.settings.open) els.settings.showModal();
  els.apiKey.focus();
}
$("settingsBtn").addEventListener("click", openSettings);
els.settings.addEventListener("close", () => {
  if (els.settings.returnValue !== "save") return;
  const key = els.apiKey.value.trim();
  if (key) send({ type: "key", key });
  send({ type: "model", id: els.model.value });
  state.speakReplies = els.speak.checked;
  save("speak", state.speakReplies);
  if (els.voice.value) {
    state.voice = els.voice.value;
    save("voice", state.voice);
  }
});
els.settings.addEventListener("close", () => { if (playback && state.phase !== "speaking") stopSpeaking(); });

// MARK: Sessions

// Each conversation is saved in this browser's localStorage: what was said (for the log) and, after
// each turn, Claude's history without screenshots plus the open tabs (to continue it). The index
// lists them; each session has its own key so saving one doesn't rewrite the rest.

const MAX_SESSIONS = 50;
const sessionKey = (id) => `session.${id}`;
const sessionIndex = () => load("sessions", []);

function readSession(id) {
  return id ? load(sessionKey(id), null) : null;
}

function newSession() {
  state.sessionId = crypto.randomUUID();
  save("current", state.sessionId);
}

/** Merges `patch` into the current session and saves it, making room by dropping the oldest. */
function updateSession(patch) {
  if (!state.sessionId) newSession();
  const id = state.sessionId;
  const now = Date.now();
  const session = { id, created: now, entries: [], messages: [], tabs: [], ...readSession(id), ...patch, updated: now };
  if (!session.title) session.title = session.entries.find((e) => e.kind === "you")?.text ?? "";
  if (!session.title && !session.messages.length) return; // nothing worth keeping yet
  let index = sessionIndex().filter((e) => e.id !== id);
  index.unshift({ id, title: session.title, updated: now, turns: session.entries.filter((e) => e.kind === "you").length });
  while (index.length > MAX_SESSIONS) localRemove(sessionKey(index.pop().id));
  for (;;) {
    if (store(sessionKey(id), session) && store("sessions", index)) return;
    const oldest = index.length > 1 ? index.pop() : null;
    if (!oldest) {
      if (!state.warnedFull) addEntry("problem", "Couldn't save this session: the browser's storage is full.");
      state.warnedFull = true;
      return;
    }
    localRemove(sessionKey(oldest.id));
  }
}

function remember(kind, text) {
  const session = readSession(state.sessionId);
  updateSession({ entries: [...(session?.entries ?? []), { kind, text, at: Date.now() }] });
}

let tabsTimer = null;
function saveTabsSoon(tabs) {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(() => {
    if (!readSession(state.sessionId)) return;
    const open = (tabs ?? []).filter((t) => /^https?:/.test(t.url)).map((t) => ({ url: t.url, title: t.title, active: !!t.active }));
    if (open.length) updateSession({ tabs: open });
  }, 1500);
}

function renderLog(entries) {
  clearLog();
  for (const e of entries ?? []) addEntry(e.kind, e.text);
}

/**
 * Matches this page with the server after connecting. Same session: show its log. A fresh server
 * (just started): continue this page's last session where it left off.
 */
function syncSession(serverId) {
  if (serverId && serverId === state.sessionId) return renderLog(readSession(serverId)?.entries);
  if (serverId) {
    // Another window moved the server to a different session; follow it.
    state.sessionId = serverId;
    save("current", serverId);
    return renderLog(readSession(serverId)?.entries);
  }
  const saved = readSession(state.sessionId);
  if (saved && (saved.messages?.length || saved.tabs?.length)) return resumeSession(saved);
  renderLog(saved?.entries);
}

function resumeSession(session) {
  stopSpeaking();
  state.sessionId = session.id;
  save("current", session.id);
  renderLog(session.entries);
  addEntry("step", `Continuing "${firstSentence(session.title || "this session", 60)}". Reopening its tabs…`);
  setPhase("working", "Picking up where you left off…");
  send({ type: "resume", sessionId: session.id, model: session.model, messages: session.messages ?? [], tabs: session.tabs ?? [] });
}

function openSessions() {
  const index = sessionIndex();
  els.sessionsEmpty.hidden = index.length > 0;
  els.sessionList.replaceChildren(...index.map((entry) => {
    const li = document.createElement("li");
    li.setAttribute("aria-current", String(entry.id === state.sessionId));
    const what = document.createElement("span");
    what.className = "what";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = entry.title || "Untitled";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${when(entry.updated)} · ${entry.turns} ${entry.turns === 1 ? "request" : "requests"}`;
    what.append(title, meta);

    const go = document.createElement("button");
    go.type = "button";
    go.className = "ghost small";
    const isCurrent = entry.id === state.sessionId;
    go.textContent = isCurrent ? "Current" : "Continue";
    go.disabled = isCurrent;
    go.addEventListener("click", () => {
      const session = readSession(entry.id);
      els.sessions.close();
      if (!session) return addEntry("problem", "That session is no longer saved.");
      if (state.phase === "working") send({ type: "stop" });
      resumeSession(session);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.setAttribute("aria-label", `Delete "${entry.title || "Untitled"}"`);
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener("click", () => {
      localRemove(sessionKey(entry.id));
      store("sessions", sessionIndex().filter((e) => e.id !== entry.id));
      if (isCurrent) resetConversation();
      openSessions();
    });

    li.append(what, go, del);
    return li;
  }));
  if (!els.sessions.open) els.sessions.showModal();
}
$("sessionsBtn").addEventListener("click", openSessions);

function when(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// MARK: Helpers

function firstSentence(text, max = 90) {
  const one = text.replace(/\s+/g, " ").trim();
  const cut = one.match(/^.+?[.!?](\s|$)/)?.[0] ?? one;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut.trim();
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function load(key, fallback) {
  try { const v = localStorage.getItem(`voiceuse.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  store(key, value);
}
/** Saves to localStorage; false when it's full or unavailable. */
function store(key, value) {
  try { localStorage.setItem(`voiceuse.${key}`, JSON.stringify(value)); return true; } catch { return false; }
}
function localRemove(key) {
  try { localStorage.removeItem(`voiceuse.${key}`); } catch { /* unavailable */ }
}

setPhase("idle");
connect();
