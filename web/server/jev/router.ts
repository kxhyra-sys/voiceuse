import { refusal } from "../urlPolicy.ts";
import { JevAuthError, type Answer, type JevClient, type JevQuestions } from "./client.ts";
import { CLICKISH, INSTRUCTIONS, INTENTS, KNOWN_SITES, RISKY_LABEL, THRESHOLDS, type Intent } from "./questions.ts";

export interface ClickTarget {
  ref: string;
  /** How the element reads, e.g. `button "Sign in"`. */
  label: string;
}

export interface RouterInput {
  utterance: string;
  /** Claude's last reply when it ended with a question, so "yes"/"no" can be read as an answer. */
  claudeQuestion: string | null;
  tabs: Array<{ id: string; title: string; active: boolean }>;
  /** Called only when the utterance looks like a click, so other commands skip reading the page. */
  clickTargets: () => Promise<ClickTarget[]>;
}

export type Decision =
  | { kind: "claude"; reason: string }
  | { kind: "stop" }
  | { kind: "reset" }
  | { kind: "decline" }
  | { kind: "scroll"; dir: "up" | "down" | "top" | "bottom" }
  | { kind: "history"; dir: "back" | "forward" }
  | { kind: "reload" }
  | { kind: "newTab" }
  | { kind: "closeTab"; tabId: string; title: string }
  | { kind: "switchTab"; tabId: string; title: string }
  | { kind: "click"; ref: string; label: string }
  | { kind: "navigate"; url: string };

export interface RouterResult {
  decision: Decision;
  ms: number;
  requestId?: string;
  model?: string;
  answers?: Record<string, Answer>;
}

const MAX_ELEMENTS = 255;

/**
 * Asks Jev, in one request, every question the next step might need, then decides in code whether a
 * spoken command can run directly or needs Claude. Anything unsure goes to Claude.
 */
export class JevRouter {
  enabled: boolean;

  constructor(private readonly jev: JevClient | null) {
    this.enabled = jev !== null;
  }

  async decide(input: RouterInput, signal: AbortSignal): Promise<RouterResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    if (!this.enabled || !this.jev) return { decision: claude("Jev is off"), ms: 0 };

    const targets = CLICKISH.test(input.utterance) ? (await input.clickTargets().catch(() => [])).slice(0, MAX_ELEMENTS) : [];
    const { state, questions } = buildRequest(input, targets);

    let answers: Record<string, Answer>;
    let meta: { requestId?: string; model?: string };
    try {
      const result = await this.jev.ask(state, questions, signal);
      answers = result.answers;
      meta = { requestId: result.requestId, model: result.model };
    } catch (err) {
      if (err instanceof JevAuthError) this.enabled = false;
      return { decision: claude(`Jev failed: ${err instanceof Error ? err.message : String(err)}`), ms: elapsed() };
    }
    return { decision: rules(input, targets, answers), ms: elapsed(), answers, ...meta };
  }
}

const claude = (reason: string): Decision => ({ kind: "claude", reason });

function buildRequest(input: RouterInput, targets: ClickTarget[]) {
  const tabs = input.tabs.map((t, i) => `t${i + 1}: ${t.title}${t.active ? " (active)" : ""}`);
  const state = {
    utterance: input.utterance,
    claude_question: input.claudeQuestion,
    tabs,
    ...(targets.length ? { page_elements: targets.map((t, i) => `e${i + 1}: ${t.label}`) } : {}),
    known_sites: Object.keys(KNOWN_SITES),
  };

  const intents = { ...INTENTS } as Record<string, unknown>;
  if (!input.claudeQuestion) delete intents.answer;

  const questions: JevQuestions = {
    intent: { type: "choice", instructions: INSTRUCTIONS.intent, criteria: intents },
    multi_step: { type: "noul", instructions: INSTRUCTIONS.multi_step },
    risky_request: { type: "noul", instructions: INSTRUCTIONS.risky_request },
    scroll_dir: { type: "choice", instructions: INSTRUCTIONS.scroll_dir, criteria: { up: null, down: null, top: "Jump to the top of the page", bottom: "Jump to the bottom of the page" } },
    history_dir: { type: "choice", instructions: INSTRUCTIONS.history_dir, criteria: { back: null, forward: null } },
    site: { type: "choice", instructions: INSTRUCTIONS.site, criteria: { ...Object.fromEntries(Object.keys(KNOWN_SITES).map((k) => [k, null])), none: "Not in the list" } },
  };
  if (input.tabs.length > 1) {
    questions.tab_target = { type: "choice", instructions: INSTRUCTIONS.tab_target, criteria: { ...Object.fromEntries(tabs.map((t) => [t.split(":")[0], t])), none: null } };
  }
  if (targets.length) {
    questions.click_target = {
      type: "choice",
      instructions: INSTRUCTIONS.click_target,
      criteria: { ...Object.fromEntries(targets.map((t, i) => [`e${i + 1}`, t.label])), none: "No element clearly matches" },
    };
  }
  if (input.claudeQuestion) {
    questions.reply = {
      type: "choice",
      instructions: INSTRUCTIONS.reply,
      criteria: { yes: "Agrees or says go ahead", no: "Refuses, says don't, or cancels", something_else: "Gives a different instruction or a detail" },
    };
  }
  return { state, questions };
}

function rules(input: RouterInput, targets: ClickTarget[], a: Record<string, Answer>): Decision {
  const pick = (key: string) => {
    const answer = a[key];
    return answer?.type === "choice" ? answer : null;
  };
  const p = (key: string) => {
    const answer = a[key];
    return answer?.type === "noul" ? answer.noul : 0;
  };
  const sure = (key: string, min: number) => {
    const answer = pick(key);
    return answer && answer.confidence >= min ? answer.choice : null;
  };

  const intent = pick("intent");
  if (!intent) return claude("no intent");
  if (p("multi_step") > THRESHOLDS.multiStep) return claude("multi-step request");
  const conf = intent.confidence;

  switch (intent.choice as Intent) {
    case "stop":
      return conf >= THRESHOLDS.stop ? { kind: "stop" } : claude("unsure stop");
    case "reset":
      return conf >= THRESHOLDS.reset ? { kind: "reset" } : claude("unsure reset");
    case "answer": {
      // Only a "no" can be handled without Claude; a "yes" means Claude has to go and do it.
      if (conf >= THRESHOLDS.reply && sure("reply", THRESHOLDS.reply) === "no") return { kind: "decline" };
      return claude("answer to Claude's question");
    }
    case "scroll": {
      const dir = conf >= THRESHOLDS.lowRisk ? sure("scroll_dir", THRESHOLDS.lowRisk) : null;
      return dir ? { kind: "scroll", dir: dir as "up" | "down" | "top" | "bottom" } : claude("unsure scroll");
    }
    case "history": {
      const dir = conf >= THRESHOLDS.lowRisk ? sure("history_dir", THRESHOLDS.lowRisk) : null;
      return dir ? { kind: "history", dir: dir as "back" | "forward" } : claude("unsure history");
    }
    case "reload":
      return conf >= THRESHOLDS.lowRisk ? { kind: "reload" } : claude("unsure reload");
    case "tab_new":
      return conf >= THRESHOLDS.lowRisk ? { kind: "newTab" } : claude("unsure new tab");
    case "tab_close": {
      if (conf < THRESHOLDS.lowRisk) return claude("unsure close tab");
      const tab = namedTab(input, sure("tab_target", THRESHOLDS.tabTarget)) ?? input.tabs.find((t) => t.active);
      return tab ? { kind: "closeTab", tabId: tab.id, title: tab.title } : claude("no tab to close");
    }
    case "tab_switch": {
      const tab = conf >= THRESHOLDS.lowRisk ? namedTab(input, sure("tab_target", THRESHOLDS.tabTarget)) : null;
      return tab ? { kind: "switchTab", tabId: tab.id, title: tab.title } : claude("unsure which tab");
    }
    case "click": {
      if (conf < THRESHOLDS.clickIntent) return claude("unsure click");
      const key = sure("click_target", THRESHOLDS.clickTarget);
      const target = key && key !== "none" ? targets[Number(key.slice(1)) - 1] : undefined;
      if (!target) return claude("unsure click target");
      if (p("risky_request") > THRESHOLDS.riskyRequest || RISKY_LABEL.test(target.label)) return claude("click may be irreversible");
      return { kind: "click", ref: target.ref, label: target.label };
    }
    case "go_to_site": {
      if (conf < THRESHOLDS.lowRisk) return claude("unsure site");
      const spoken = spokenDomain(input.utterance);
      const site = sure("site", THRESHOLDS.site);
      const url = spoken ?? (site && site !== "none" ? KNOWN_SITES[site] : undefined);
      if (!url || refusal(url)) return claude("site not allowed or unknown");
      return { kind: "navigate", url };
    }
    default:
      return claude("task");
  }
}

function namedTab(input: RouterInput, key: string | null) {
  if (!key || key === "none") return undefined;
  return input.tabs[Number(key.slice(1)) - 1];
}

/** "go to github dot com" → https://github.com. Only plain host names; anything odd goes to Claude. */
export function spokenDomain(utterance: string): string | undefined {
  const text = utterance.toLowerCase().replace(/\s+dot\s+/g, ".").replace(/\s+slash\s+/g, "/");
  const match = text.match(/\b((?:[a-z0-9-]+\.)+[a-z0-9-]+)(\/[^\s]*)?/);
  if (!match) return undefined;
  return `https://${match[1]}${match[2] ?? ""}`;
}
