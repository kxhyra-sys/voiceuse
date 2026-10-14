import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AnthropicBeta } from "@anthropic-ai/sdk/resources/beta/beta";
import type { BetaBrowserToolset20260801 } from "@anthropic-ai/sdk/resources/beta";
import { SYSTEM_PROMPT } from "./prompt.ts";

export const MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (faster, cheaper)" },
] as const;

/** Server-side refusal fallback, between-tool progress notes, and old-screenshot clearing. */
const OPTIONAL_BETAS: AnthropicBeta[] = [
  "server-side-fallback-2026-07-01",
  "thinking-display-updates-2026-08-18",
  "context-management-2025-06-27",
];

const NOT_EXECUTED = "Not executed: an earlier action in this turn failed.";

export interface AgentConfig {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  maxSteps: number;
  /** Dropped for the rest of the session if the API rejects them with a 400. */
  useBetas: boolean;
}

export interface AgentEvents {
  /** A short progress note from Claude ("Opening the ticket page…"). */
  onNote(text: string): void;
  /** The browser action about to run, e.g. "left_click ref_4". */
  onAction(summary: string): void;
  onLog(text: string): void;
}

export type Outcome =
  | { kind: "reply"; text: string }
  | { kind: "stepLimit" }
  | { kind: "refused"; text: string }
  | { kind: "truncated"; text: string };

/** What the agent needs from the browser toolset. `PlaywrightBrowser` is one. */
export interface Toolset {
  readonly toolsetName: string;
  toJSON(): BetaBrowserToolset20260801;
  toolResult(toolUse: BetaToolUseBlock): Promise<BetaToolResultBlockParam>;
}

export type CreateMessage = (
  params: MessageCreateParamsNonStreaming,
  options: { signal: AbortSignal },
) => Promise<BetaMessage>;

export function anthropicCreate(client = new Anthropic()): CreateMessage {
  return (params, options) => client.beta.messages.create(params, { signal: options.signal, timeout: 300_000 });
}

/**
 * The Messages API loop for the browser toolset. Keeps the conversation between runs so follow-ups
 * ("now open the second one") have context; `reset()` starts fresh. The history is append-only,
 * as preserved thinking requires.
 */
export class BrowserAgent {
  config: AgentConfig = {
    model: process.env.VOICEUSE_MODEL ?? MODELS[0].id,
    effort: "medium",
    maxTokens: 16_000,
    maxSteps: 40,
    useBetas: true,
  };
  private messages: BetaMessageParam[] = [];

  constructor(
    private readonly create: CreateMessage,
    private readonly toolset: Toolset,
    private readonly events: AgentEvents,
  ) {}

  get messageCount() {
    return this.messages.length;
  }

  reset() {
    this.messages = [];
  }

  /** The conversation so far, for saving. Don't modify it. */
  get history(): readonly BetaMessageParam[] {
    return this.messages;
  }

  /** Continues a saved conversation. */
  load(messages: BetaMessageParam[]) {
    this.messages = structuredClone(messages);
    this.repairHistory();
  }

  buildRequest(): MessageCreateParamsNonStreaming {
    const params: MessageCreateParamsNonStreaming = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: SYSTEM_PROMPT,
      tools: [this.toolset.toJSON()],
      messages: this.messages,
      output_config: { effort: this.config.effort },
      // Caches the growing prefix, so each step pays mostly for the newest screenshot.
      cache_control: { type: "ephemeral" },
    };
    if (this.config.useBetas) {
      params.betas = OPTIONAL_BETAS;
      params.fallbacks = "default";
      params.thinking = { type: "adaptive", display: "updates" };
      params.context_management = { edits: [{ type: "clear_tool_uses_20250919" }] };
    }
    return params;
  }

  async run(text: string, signal: AbortSignal): Promise<Outcome> {
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    try {
      return await this.loop(signal);
    } catch (err) {
      this.repairHistory();
      throw err;
    }
  }

  /**
   * After a cancel or failure mid-turn an assistant `tool_use` may have no `tool_result`, which the
   * API rejects. Answer each dangling call with an error result so the history stays valid.
   */
  private repairHistory() {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant" || typeof last.content === "string") return;
    const dangling = last.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (dangling.length === 0) return;
    this.messages.push({
      role: "user",
      content: dangling.map((call) => ({
        type: "tool_result" as const,
        tool_use_id: call.id,
        ...(call.toolset_name ? { toolset_name: call.toolset_name } : {}),
        content: "Interrupted by the user before this action ran.",
        is_error: true,
      })),
    } as BetaMessageParam);
  }

  private async loop(signal: AbortSignal): Promise<Outcome> {
    for (let step = 1; step <= this.config.maxSteps; step++) {
      signal.throwIfAborted();
      const response = await this.request(signal);
      this.messages.push({ role: "assistant", content: response.content });
      this.events.onLog(`step ${step}: stop_reason=${response.stop_reason}, ${response.content.length} blocks`);

      for (const block of response.content) {
        if (block.type === "thinking" && block.thinking.trim()) this.events.onNote(block.thinking.trim());
      }
      const text = response.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join(" ")
        .trim();

      switch (response.stop_reason) {
        case "tool_use": {
          if (text) this.events.onNote(text);
          const calls = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
          const results = await this.execute(calls, signal);
          this.messages.push({ role: "user", content: results });
          break;
        }
        case "pause_turn":
          break;
        case "refusal":
          return { kind: "refused", text: response.stop_details?.explanation ?? "I can't help with that one." };
        case "max_tokens":
          return { kind: "truncated", text };
        default:
          return { kind: "reply", text };
      }
    }
    return { kind: "stepLimit" };
  }

  /** Sends the request; on a 400 with the optional betas on, retries once without them. */
  private async request(signal: AbortSignal): Promise<BetaMessage> {
    try {
      return await this.create(this.buildRequest(), { signal });
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && this.config.useBetas) {
        this.events.onLog(`400 with optional betas (${err.message}); retrying without them`);
        this.config.useBetas = false;
        return this.create(this.buildRequest(), { signal });
      }
      throw err;
    }
  }

  /** Runs a turn's calls in order and stops at the first failure, as the toolset requires. */
  private async execute(calls: BetaToolUseBlock[], signal: AbortSignal): Promise<BetaToolResultBlockParam[]> {
    const results: BetaToolResultBlockParam[] = [];
    let failed = false;
    for (const call of calls) {
      if (failed || signal.aborted || call.toolset_name !== this.toolset.toolsetName) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          ...(call.toolset_name ? { toolset_name: call.toolset_name } : {}),
          content: failed || !signal.aborted ? NOT_EXECUTED : "Interrupted by the user before this action ran.",
          is_error: true,
        } as BetaToolResultBlockParam);
        failed = true;
        continue;
      }
      this.events.onAction(describe(call));
      const result = withoutZoomState(call, await this.toolset.toolResult(call));
      if (result.is_error) {
        failed = true;
        this.events.onLog(`${call.name} failed: ${JSON.stringify(result.content).slice(0, 300)}`);
      }
      results.push(result);
    }
    signal.throwIfAborted();
    return results;
  }
}

/**
 * The browser use tool docs say a `zoom` result never carries a `browser_state` block, but the SDK
 * attaches one to every successful result. Drop it there.
 */
function withoutZoomState(call: BetaToolUseBlock, result: BetaToolResultBlockParam): BetaToolResultBlockParam {
  if (call.name !== "zoom" || !Array.isArray(result.content)) return result;
  return { ...result, content: result.content.filter((b) => b.type !== "browser_state") } as BetaToolResultBlockParam;
}

/** A short phrase for the UI, e.g. "clicking ref_4" or "opening example.com". */
export function describe(call: BetaToolUseBlock): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const target = input.target as { type?: string; ref?: string; x?: number; y?: number } | undefined;
  const where = target
    ? target.type === "ref" ? target.ref : `(${Math.round(target.x ?? 0)}, ${Math.round(target.y ?? 0)})`
    : "";
  const short = (s: unknown, n = 32) => {
    const t = String(s ?? "");
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  switch (call.name) {
    case "navigate": {
      const url = String(input.url ?? "");
      if (["back", "forward", "reload"].includes(url)) return `going ${url === "reload" ? "to reload" : url}`;
      return `opening ${short(url.replace(/^https?:\/\//, ""), 40)}`;
    }
    case "screenshot": return "looking at the page";
    case "zoom": return "zooming in";
    case "read_page": return "reading the page";
    case "get_page_text": return "reading the text";
    case "find": return `looking for "${short(input.query)}"`;
    case "left_click": return `clicking ${where}`;
    case "right_click": return `right-clicking ${where}`;
    case "double_click": return `double-clicking ${where}`;
    case "triple_click": return `triple-clicking ${where}`;
    case "middle_click": return `middle-clicking ${where}`;
    case "hover": return `hovering ${where}`;
    case "type": return `typing "${short(input.text)}"`;
    case "key": return `pressing ${short(input.text)}`;
    case "scroll": return `scrolling ${String(input.scroll_direction ?? "")}`;
    case "scroll_to": return `scrolling to ${(input.target as { ref?: string } | undefined)?.ref ?? ""}`;
    case "form_input": return `filling ${(input.target as { ref?: string } | undefined)?.ref ?? "a field"}`;
    case "wait": return `waiting ${String(input.duration ?? "")}s`;
    case "new_tab": return "opening a new tab";
    case "switch_tab": return "switching tabs";
    case "close_tab": return "closing a tab";
    case "list_tabs": return "checking the tabs";
    default: return call.name.replaceAll("_", " ");
  }
}
