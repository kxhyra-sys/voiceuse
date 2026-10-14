/**
 * Functions that run inside the page (via page.evaluate). Each is self-contained: Playwright
 * serializes the function's source, so nothing outside its body is in scope.
 *
 * Element references ("ref_12") live in a page-side registry. An element keeps its ref for as
 * long as it stays in the DOM; refs are never renumbered. A navigation clears the registry, which
 * makes old refs stale, as the browser use tool expects.
 */

export interface TreeArgs {
  mode: "read" | "find";
  filter?: "interactive" | "all" | null;
  depth?: number | null;
  ref?: string | null;
  query?: string | null;
}

export const LIMIT = 50_000;

export function pageTree(args: TreeArgs): string {
  type Registry = { refs: Map<string, Element>; ids: WeakMap<Element, string>; next: number };
  const w = window as unknown as { __claude?: Registry };
  const reg = (w.__claude ??= { refs: new Map(), ids: new WeakMap(), next: 1 });

  const refFor = (el: Element): string => {
    let id = reg.ids.get(el);
    if (!id) {
      id = `ref_${reg.next++}`;
      reg.ids.set(el, id);
      reg.refs.set(id, el);
    }
    return id;
  };

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem",
  ]);

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : null;
      case "button": case "summary": return "button";
      case "select": return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
      case "textarea": return "textbox";
      case "option": return "option";
      case "img": return "img";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "nav": return "navigation";
      case "main": return "main";
      case "form": return "form";
      case "dialog": return "dialog";
      case "table": return "table";
      case "label": return "label";
      case "iframe": return "iframe";
      case "input": {
        const type = ((el as HTMLInputElement).type || "text").toLowerCase();
        if (type === "hidden") return null;
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        return "textbox";
      }
    }
    if ((el as HTMLElement).isContentEditable && el.parentElement && !el.parentElement.isContentEditable) return "textbox";
    if (el.hasAttribute("onclick") || (el.getAttribute("tabindex") ?? "-1") !== "-1") return "generic-clickable";
    return null;
  };

  const clean = (s: string | null | undefined, max = 100): string => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (text.trim()) return clean(text);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "img") return clean(el.getAttribute("alt") || el.getAttribute("title"));
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const input = el as HTMLInputElement;
      const label = input.labels?.[0]?.textContent;
      if (label?.trim()) return clean(label);
      if (["button", "submit", "reset"].includes(input.type)) return clean(input.value);
      return clean(input.placeholder || el.getAttribute("title") || input.name);
    }
    const text = (el as HTMLElement).innerText ?? el.textContent;
    return clean(text || el.getAttribute("title"));
  };

  const style = (el: Element) => getComputedStyle(el);
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && style(el).display !== "contents") return false;
    const s = style(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const inViewport = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  const details = (el: Element, role: string): string => {
    const bits: string[] = [];
    const tag = el.tagName.toLowerCase();
    if (role === "heading") bits.push(`level=${tag.slice(1) || el.getAttribute("aria-level")}`);
    if (role === "link") {
      const href = el.getAttribute("href") ?? "";
      if (href && !href.startsWith("javascript:")) bits.push(`href="${clean(href, 80)}"`);
    }
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") bits.push(input.checked ? "checked" : "unchecked");
      else if (input.type === "password") bits.push(input.value ? `value=(${input.value.length} hidden chars)` : "empty");
      else if (input.value) bits.push(`value="${clean(input.value, 60)}"`);
    }
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      bits.push(`selected="${clean(sel.selectedOptions[0]?.textContent, 60)}"`);
      const opts = [...sel.options].slice(0, 15).map((o) => clean(o.textContent, 40));
      bits.push(`options=[${opts.map((o) => `"${o}"`).join(", ")}${sel.options.length > 15 ? ", …" : ""}]`);
    }
    const checked = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected") ?? el.getAttribute("aria-pressed");
    if (checked) bits.push(`checked=${checked}`);
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) bits.push(`expanded=${expanded}`);
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    return bits.length ? ` ${bits.join(" ")}` : "";
  };

  const line = (el: Element, role: string, indent: number): string => {
    const name = nameOf(el);
    const shown = role === "generic-clickable" ? "clickable" : role;
    return `${"  ".repeat(indent)}${shown}${name ? ` "${name.replaceAll('"', "'")}"` : ""} [${refFor(el)}]${details(el, role)}`;
  };

  const children = (el: Element | ShadowRoot): Element[] => {
    const kids = [...el.children];
    if (el instanceof Element && el.shadowRoot) kids.unshift(...el.shadowRoot.children);
    return kids;
  };

  const ownText = (el: Element): string =>
    clean([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(" "), 160);

  if (args.mode === "find") {
    const words = clean(args.query, 200).toLowerCase().split(/\s+/).filter(Boolean);
    const scored: Array<{ el: Element; role: string; score: number }> = [];
    const walk = (node: Element | ShadowRoot) => {
      for (const el of children(node)) {
        if (!isVisible(el) && el.tagName.toLowerCase() !== "option") { walk(el); continue; }
        const role = roleOf(el);
        if (role) {
          const hay = `${role} ${nameOf(el)} ${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("name") ?? ""}`.toLowerCase();
          const score = words.filter((w) => hay.includes(w)).length + (INTERACTIVE_ROLES.has(role) ? 0.5 : 0);
          if (score >= 1) scored.push({ el, role, score });
        }
        walk(el);
      }
    };
    walk(document.documentElement);
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 20);
    if (top.length === 0) return `No elements match "${clean(args.query, 80)}".`;
    return top.map(({ el, role }) => line(el, role, 0)).join("\n");
  }

  const filter = args.filter ?? null;
  const maxDepth = Math.max(1, Math.min(args.depth ?? 15, 15));
  let root: Element = document.body ?? document.documentElement;
  if (args.ref) {
    const scoped = reg.refs.get(args.ref);
    if (!scoped || !scoped.isConnected) {
      return `__STALE__`;
    }
    root = scoped;
  }

  const out: string[] = [];
  let size = 0;
  let truncated = false;
  const push = (s: string) => {
    if (size + s.length + 1 > 50_000) { truncated = true; return false; }
    out.push(s);
    size += s.length + 1;
    return true;
  };

  const walk = (node: Element | ShadowRoot, indent: number, depth: number) => {
    if (truncated || depth > maxDepth) return;
    for (const el of children(node)) {
      if (truncated) return;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template", "svg", "head", "meta", "link"].includes(tag)) continue;
      if (!isVisible(el)) continue;
      if (filter !== "all" && !inViewport(el) && el.getBoundingClientRect().height < innerHeight * 3) {
        // Off-screen and not a big container that might reach into the viewport.
        continue;
      }
      const role = roleOf(el);
      const interactive = role !== null && (INTERACTIVE_ROLES.has(role) || role === "generic-clickable");
      let shown = false;
      if (role && (filter !== "interactive" || interactive)) {
        if (!push(line(el, role, indent))) return;
        shown = true;
        // A link or button's text is in its name already.
        if (interactive || role === "heading" || role === "img") continue;
      } else if (filter !== "interactive") {
        const text = ownText(el);
        if (text) {
          if (!push(`${"  ".repeat(indent)}text "${text.replaceAll('"', "'")}"`)) return;
        }
      }
      walk(el, shown ? indent + 1 : indent, depth + 1);
    }
  };
  walk(root, 0, 1);

  if (out.length === 0) return filter === "interactive" ? "No interactive elements are visible." : "The page shows no readable content.";
  if (truncated) out.push("[Output truncated at 50,000 characters. Scope with ref, a lower depth or filter=interactive.]");
  return out.join("\n");
}

/** Visible page text, the main article first when the page has one. */
export function pageText(): string {
  const main = document.querySelector("article, main, [role=main]") as HTMLElement | null;
  const body = document.body as HTMLElement | null;
  const primary = main?.innerText?.trim() ?? "";
  const all = body?.innerText?.trim() ?? "";
  let text = primary.length > 400 ? primary : all;
  text = text.replace(/\n{3,}/g, "\n\n");
  const title = document.title ? `Title: ${document.title}\n\n` : "";
  const full = title + text;
  return full.length > 50_000 ? `${full.slice(0, 50_000)}\n[Text truncated at 50,000 characters.]` : full;
}

/** The element a ref names, or null when it is gone. Use with page.evaluateHandle. */
export function resolveRef(ref: string): Element | null {
  const w = window as unknown as { __claude?: { refs: Map<string, Element> } };
  const el = w.__claude?.refs.get(ref);
  return el && el.isConnected ? el : null;
}
