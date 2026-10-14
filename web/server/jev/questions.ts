/**
 * Every Jev question, option description and threshold the router uses, in one place so they can be
 * reviewed and tuned together. Thresholds are starting points; tune them from the decision log.
 */

export const JEV_MODEL = "jev-1.13.0";

export const THRESHOLDS = {
  /** Above this, the request needs planning or reading the page, so Claude handles it. */
  multiStep: 0.3,
  stop: 0.8,
  reset: 0.85,
  /** Scroll, back/forward, reload and tab actions: cheap and undoable. */
  lowRisk: 0.6,
  clickIntent: 0.75,
  clickTarget: 0.8,
  /** Above this, the user is asking to send/buy/delete/submit something: Claude asks first. */
  riskyRequest: 0.15,
  site: 0.8,
  reply: 0.75,
  tabTarget: 0.8,
} as const;

/** Labels that mean a click could do something irreversible. Checked in code, not by Jev. */
export const RISKY_LABEL = /\b(send|buy|pay|purchase|order|checkout|check out|delete|remove|submit|post|publish|confirm|transfer|sign up|subscribe)\b/i;

/** Utterances that might name something on the page, so the page's elements are worth sending. */
export const CLICKISH = /\b(click|tap|press|open|select|choose|hit|follow|pick)\b/i;

/** Sites Jev can pick by name. A spoken domain ("github dot com") is handled in code instead. */
export const KNOWN_SITES: Record<string, string> = {
  google: "https://www.google.com",
  youtube: "https://www.youtube.com",
  gmail: "https://mail.google.com",
  google_maps: "https://maps.google.com",
  github: "https://github.com",
  wikipedia: "https://www.wikipedia.org",
  amazon: "https://www.amazon.com",
  reddit: "https://www.reddit.com",
  x_twitter: "https://x.com",
  linkedin: "https://www.linkedin.com",
  netflix: "https://www.netflix.com",
  bbc_news: "https://www.bbc.co.uk/news",
};

/**
 * Intent options. `task` is first on purpose: Jev leans slightly towards the first option, and
 * `task` (hand to Claude) is the safe fallback.
 */
export const INTENTS = {
  task: {
    what: "Anything that needs planning, several steps, typing text, filling a form, searching, reading or summarising the page, or answering a question about it",
    not_for: "A single scroll, back/forward, reload, tab change, one click on a named element, or opening one named site",
    examples: ["find me a flight to Rome", "what does this page say about pricing", "search for running shoes", "reply to the last email"],
  },
  stop: {
    what: "The user wants the assistant to stop or cancel what it is doing right now",
    examples: ["stop", "cancel that", "never mind", "hold on, stop"],
  },
  reset: {
    what: "The user wants to forget the conversation and start a new one",
    examples: ["start over", "new conversation", "forget everything and reset"],
  },
  answer: {
    what: "A direct reply to the question in `claude_question`, such as yes, no, or a short answer",
    not_for: "Use only when `claude_question` is not null",
    examples: ["yes go ahead", "no don't", "yeah send it"],
  },
  scroll: {
    what: "Scroll the current page up or down, or jump to its top or bottom",
    examples: ["scroll down", "go to the bottom", "page up", "back to the top"],
  },
  history: {
    what: "Go back to the previous page or forward to the next page in the tab's history",
    examples: ["go back", "previous page", "go forward"],
  },
  reload: {
    what: "Reload or refresh the current page",
    examples: ["refresh", "reload the page"],
  },
  tab_new: { what: "Open a new empty tab", examples: ["new tab", "open a new tab"] },
  tab_close: { what: "Close a tab (the current one unless another is named)", examples: ["close this tab", "close the GitHub tab"] },
  tab_switch: { what: "Switch to another open tab, listed in `tabs`", examples: ["switch to the Gmail tab", "next tab", "go to the other tab"] },
  click: {
    what: "Click, press or open exactly one element that is on the current page, named by its text",
    not_for: "Opening a website that is not on the page; clicking several things; typing text",
    examples: ["click sign in", "press the blue button", "open the second result"],
  },
  go_to_site: {
    what: "Open a website by its name or address",
    not_for: "Searching for something on a site",
    examples: ["go to github", "open youtube", "go to bbc dot co dot uk"],
  },
} as const;

export type Intent = keyof typeof INTENTS;

export const INSTRUCTIONS = {
  intent: "Which single browser command does `utterance` ask for? If it asks for more than one thing or needs judgment, choose task.",
  multi_step:
    "Does `utterance` need more than one browser action, typing text, or reading and understanding the page's content to carry out? Opening one website by name, one click, one scroll, or one tab change is a single action, so the answer for those is no.",
  scroll_dir: "Which way does `utterance` ask to scroll?",
  history_dir: "Does `utterance` ask to go back or forward in history?",
  tab_target: "Which tab in `tabs` does `utterance` refer to? Choose none if it names no tab or the current one.",
  click_target: "Which single element in `page_elements` does `utterance` ask to click? Choose none if no element clearly matches.",
  site: "Which site in `known_sites` does `utterance` ask to open? Choose none if it is not in the list.",
  reply: "How does `utterance` answer `claude_question`?",
  risky_request:
    "Is `utterance` asking to send, buy, pay for, delete, submit, post or confirm something that cannot easily be undone?",
} as const;
