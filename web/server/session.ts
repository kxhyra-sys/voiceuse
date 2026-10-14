/**
 * Saved conversations. The page keeps them in its localStorage; the server sends a slimmed copy of
 * Claude's history after each turn and takes one back to resume. Screenshots are dropped and long
 * page reads cut, so a session stays small enough for localStorage (a few MB for every session).
 */
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

const MAX_TEXT = 4000;
export const SCREENSHOT_DROPPED = "[Screenshot from an earlier session, not kept. Take a new one to see the page.]";

export interface SavedTab {
  url: string;
  active?: boolean;
}

/** A copy of `messages` without images and with long tool output cut. The original is untouched. */
export function slim(messages: BetaMessageParam[]): BetaMessageParam[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    return {
      ...m,
      content: m.content.map((block) => {
        if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
        return {
          ...block,
          content: block.content.map((part: any) => {
            if (part.type === "image") return { type: "text", text: SCREENSHOT_DROPPED };
            if (part.type === "text" && part.text.length > MAX_TEXT) {
              return { ...part, text: `${part.text.slice(0, MAX_TEXT)}\n[… cut when the session was saved]` };
            }
            return part;
          }),
        };
      }),
    } as BetaMessageParam;
  });
}

/**
 * Checks the shape of a history sent back by the page: it starts with the user, roles are user or
 * assistant, and every block has a type. Returns null when it is unusable, so the server starts fresh.
 */
export function validHistory(value: unknown): BetaMessageParam[] | null {
  if (!Array.isArray(value) || value.length > 2000 || (value.length && value[0]?.role !== "user")) return null;
  for (const m of value) {
    if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant")) return null;
    const ok = typeof m.content === "string"
      || (Array.isArray(m.content) && m.content.every((b: unknown) => !!b && typeof (b as { type?: unknown }).type === "string"));
    if (!ok) return null;
  }
  return value as BetaMessageParam[];
}

/** Saved tabs worth reopening: http(s) only, at most ten. */
export function validTabs(value: unknown): SavedTab[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is SavedTab => !!t && typeof t.url === "string" && /^https?:\/\//i.test(t.url))
    .slice(0, 10)
    .map((t) => ({ url: t.url, active: t.active === true }));
}
