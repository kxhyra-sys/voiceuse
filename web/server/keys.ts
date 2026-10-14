/**
 * Turns the key names Claude writes ("ctrl+a", "Return", "super+shift+t", "BackSpace") into
 * Playwright key strings ("ControlOrMeta+a", "Enter", "Meta+Shift+t", "Backspace").
 *
 * "ctrl" maps to ControlOrMeta, so ctrl+a / ctrl+c / ctrl+v do what Claude means whether the
 * browser runs on macOS (Command) or Linux/Windows (Control).
 */

const MODIFIERS: Record<string, string> = {
  shift: "Shift",
  ctrl: "ControlOrMeta",
  control: "ControlOrMeta",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  meta: "Meta",
  super: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
};

const KEYS: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  kp_enter: "Enter",
  tab: "Tab",
  space: " ",
  backspace: "Backspace",
  escape: "Escape",
  esc: "Escape",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  page_up: "PageUp",
  pageup: "PageUp",
  prior: "PageUp",
  page_down: "PageDown",
  pagedown: "PageDown",
  next: "PageDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  plus: "+",
  minus: "-",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  quote: "'",
  grave: "`",
  bracketleft: "[",
  bracketright: "]",
};

export class KeyError extends Error {}

/** One chord such as "ctrl+shift+t" → "ControlOrMeta+Shift+t". */
export function chord(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new KeyError("Empty key.");
  // "ctrl++" is ctrl and the plus key; a lone "+" is the plus key.
  let parts = trimmed.split("+");
  if (trimmed === "+") parts = ["plus"];
  else if (trimmed.endsWith("+") && parts.length >= 2) parts = [...parts.slice(0, -2), "plus"];

  const mods: string[] = [];
  let main: string | undefined;
  for (const raw of parts) {
    const token = raw.trim();
    if (!token) continue;
    const mod = MODIFIERS[token.toLowerCase().replace(/_[lr]$/, "")];
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod);
    } else {
      main = keyName(token);
    }
  }
  if (main === undefined) {
    if (mods.length === 0) throw new KeyError(`Unknown key '${text}'.`);
    return mods.join("+");
  }
  return [...mods, main].join("+");
}

function keyName(token: string): string {
  const lower = token.toLowerCase();
  if (KEYS[lower]) return KEYS[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  // Single characters pass through as typed ("a", "A", "1", "/").
  if ([...token].length === 1) return token;
  throw new KeyError(
    `Unknown key '${token}'. Use names like Enter, Tab, Escape, Backspace, ArrowUp, F5, a, ctrl+c.`,
  );
}

/** A space-separated sequence of chords, e.g. "Backspace Backspace" or "ctrl+a Delete". */
export function sequence(text: string): string[] {
  const chords = text.trim().split(/\s+/).filter(Boolean);
  if (chords.length === 0) throw new KeyError("Empty key.");
  return chords.map(chord);
}

/** Click modifiers such as "ctrl+shift" → Playwright modifier names. */
export function modifiers(text: string | null | undefined): Modifier[] {
  if (!text) return [];
  const out: Modifier[] = [];
  for (const raw of text.split("+")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    const mod = MODIFIERS[token] as Modifier | undefined;
    if (!mod) throw new KeyError(`Unknown modifier '${raw}'. Use shift, ctrl, alt or meta.`);
    if (!out.includes(mod)) out.push(mod);
  }
  return out;
}

export type Modifier = "Alt" | "ControlOrMeta" | "Meta" | "Shift";
