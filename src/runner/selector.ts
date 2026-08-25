// ---------------------------------------------------------------------------
// Selectors: naming a control the way a developer thinks about it.
//
//   "Connect with Medusa"                     -> the button with that label
//   { text: "Send", match: "contains" }       -> substring
//   { text: "/^Tip \\d+/", match: "regex" }   -> pattern
//   { objectName: "amountField" }             -> a stable handle, if the app has one
//   { type: "TextField", nth: 0 }             -> positional, last resort
//
// Resolution happens against a UiSnapshot, so it is visibility-aware, scoped
// to one app, and able to explain itself when it fails or is ambiguous.
// ---------------------------------------------------------------------------

import { type ClickVia, isClickableType, isEditableType, type UiNode, type UiSnapshot } from "./snapshot.js";

export type MatchMode = "exact" | "contains" | "regex";

export interface Selector {
  /** Visible label. */
  text?: string;
  /** How `text` is compared. Defaults to "exact"; see normaliseText. */
  match?: MatchMode;
  /** Class-name fragment filter, e.g. "Button", "TextField". */
  type?: string;
  /** QML objectName, when the app sets one. The only truly stable handle. */
  objectName?: string;
  /** Disambiguate among equally good matches. 0-based. */
  nth?: number;
  /** Match controls the user cannot see. Off by default, and rarely right. */
  includeHidden?: boolean;
  /** Require the control to be clickable (used by click steps). */
  clickable?: boolean;
  /** Require the control to accept text (used by type steps). */
  editable?: boolean;
}

export type SelectorInput = string | Selector;

export function toSelector(input: SelectorInput): Selector {
  if (typeof input !== "string") return input;
  // A bare /pattern/flags string is a regex; anything else is a literal label.
  const rx = /^\/(.*)\/([gimsu]*)$/.exec(input);
  if (rx) return { text: input, match: "regex" };
  return { text: input, match: "exact" };
}

export interface ResolvedMatch {
  /** The node whose label matched. */
  node: UiNode;
  /** What a click should actually be delivered to. */
  target: UiNode;
  via: ClickVia;
  /** Higher is better. Used to pick among candidates. */
  score: number;
  reason: string;
}

export class SelectorError extends Error {
  constructor(
    message: string,
    readonly selector: Selector,
    readonly suggestions: string[] = [],
    readonly candidates: ResolvedMatch[] = [],
  ) {
    super(message);
    this.name = "SelectorError";
  }
}

/**
 * Normalise a label before comparing.
 *
 * Real UI strings are full of typographic characters — tip_jar alone ships
 * curly quotes, an ellipsis, an arrow and a heading with two consecutive
 * spaces. Requiring a developer to reproduce those byte-for-byte turns every
 * assertion into a trap, so exact matching compares normalised forms: curly
 * quotes folded to ASCII, ellipsis expanded, whitespace collapsed, trimmed.
 */
export function normaliseText(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textMatches(actual: string, sel: Selector): boolean {
  if (sel.text === undefined) return true;
  const mode = sel.match ?? "exact";
  if (mode === "regex") {
    const rx = /^\/(.*)\/([gimsu]*)$/.exec(sel.text);
    const re = rx ? new RegExp(rx[1]!, rx[2]) : new RegExp(sel.text);
    return re.test(actual);
  }
  const a = normaliseText(actual);
  const b = normaliseText(sel.text);
  return mode === "contains" ? a.toLowerCase().includes(b.toLowerCase()) : a === b;
}

/**
 * Find everything the selector could mean, best first.
 *
 * Scoring exists because a label almost always appears more than once: as the
 * control's own `text`, as a nested Text inside it, and often in unrelated
 * prose. We prefer, in order: an exact label over a substring, a control the
 * user can interact with over inert text, a visible node over a hidden one,
 * and a shallower node over a deeper one.
 */
export function resolveAll(snapshot: UiSnapshot, sel: Selector): ResolvedMatch[] {
  // A selector that constrains nothing must match nothing. Every filter below
  // is skipped when its field is undefined, so an all-undefined selector used
  // to match the entire tree — and an assertion built on it passed whatever the
  // app rendered. That arose for real from a snake_case selector inside a list,
  // whose keys were not normalised.
  if (sel.text === undefined && sel.objectName === undefined && sel.type === undefined) return [];

  const out: ResolvedMatch[] = [];

  for (const node of snapshot.nodes) {
    if (sel.objectName !== undefined && node.objectName !== sel.objectName) continue;
    if (sel.type !== undefined && !node.type.includes(sel.type)) continue;
    if (sel.text !== undefined) {
      if (!node.text) continue;
      if (!textMatches(node.text, sel)) continue;
    }
    if (!sel.includeHidden && !node.visible) continue;

    const { target, via } = snapshot.clickTargetFor(node);
    // `hitArea` means the label sits in a container whose MouseArea we found;
    // that IS clickable even though the label's ancestors are plain Items.
    if (sel.clickable && via !== "hitArea" && !isClickableType(target.type)) continue;
    if (sel.editable && !isEditableType(node.type) && !isEditableType(target.type)) continue;
    if (!sel.includeHidden && !target.visible) continue;
    if (sel.clickable && !target.enabled) continue;

    let score = 0;
    const why: string[] = [];
    if (sel.text !== undefined && normaliseText(node.text) === normaliseText(sel.text)) {
      score += 100;
      why.push("exact label");
    }
    if (isClickableType(node.type)) {
      score += 40;
      why.push("clickable itself");
    } else if (via === "ancestor") {
      score += 30;
      why.push(`label inside ${target.type}`);
    } else if (via === "hitArea") {
      score += 25;
      why.push(`label beside a ${target.type}`);
    }
    if (node.objectName) {
      score += 20;
      why.push("has objectName");
    }
    if (node.visible) score += 10;
    if (node.enabled) score += 5;
    score -= node.depth; // prefer the outermost expression of the same label

    out.push({ node, target, via, score, reason: why.join(", ") || "matched" });
  }

  // Collapse duplicates that resolve to the same clickable target: the Button
  // and the Text inside it are one control as far as the developer is concerned.
  //
  // Text fields are the exception. Two inputs commonly sit inside one container
  // whose MouseArea is their shared click target, so collapsing on that would
  // merge "password" and "confirm password" into a single match — and then
  // `nth` could never address the second one. Key those on the field itself.
  const key = (m: ResolvedMatch) => (sel.editable ? m.node.id : m.target.id);
  const best = new Map<string, ResolvedMatch>();
  for (const m of out) {
    const k = key(m);
    const prev = best.get(k);
    if (!prev || m.score > prev.score) best.set(k, m);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.node.index - b.node.index);
}

/** Resolve to exactly one match, or throw with something actionable. */
export function resolveOne(snapshot: UiSnapshot, input: SelectorInput): ResolvedMatch {
  const sel = toSelector(input);
  const matches = resolveAll(snapshot, sel);

  if (matches.length === 0) {
    throw new SelectorError(`no element matches ${describe(sel)}${explainMiss(snapshot, sel)}`, sel, snapshot.labels().slice(0, 40));
  }

  if (sel.nth !== undefined) {
    const pick = matches[sel.nth];
    if (!pick) {
      throw new SelectorError(
        `nth: ${sel.nth} is out of range — ${describe(sel)} matched ${matches.length} element(s)`,
        sel,
        [],
        matches,
      );
    }
    return pick;
  }

  // Ambiguity is only a problem when the top candidates are equally good.
  if (matches.length > 1 && matches[0]!.score === matches[1]!.score) {
    const listing = matches
      .slice(0, 5)
      .map((m, i) => `    [${i}] ${m.target.type} ${JSON.stringify(m.node.text)}`)
      .join("\n");
    throw new SelectorError(
      `${describe(sel)} is ambiguous — ${matches.length} equally good matches:\n${listing}\n` +
        `  Narrow it with type:, objectName:, or nth:.`,
      sel,
      [],
      matches,
    );
  }
  return matches[0]!;
}

/**
 * Say why a selector found nothing.
 *
 * The useful answer is almost never "no such label" — it is "that label is
 * there, but the control is hidden right now", or "it is visible but disabled",
 * or "it is a caption, not a button". So we redo the text match with every
 * filter switched off and report the state of each candidate. Guessing at
 * typos is the last resort, and a candidate whose text equals the search term
 * is never offered as a suggestion — telling someone they might have meant the
 * exact thing they typed is noise.
 */
function explainMiss(snapshot: UiSnapshot, sel: Selector): string {
  if (sel.text === undefined) {
    return sel.objectName !== undefined
      ? `\n  No object has objectName ${JSON.stringify(sel.objectName)} in this scope.`
      : "";
  }

  const bare: Selector = { text: sel.text, includeHidden: true };
  if (sel.match) bare.match = sel.match;
  const candidates = resolveAll(snapshot, bare);

  if (candidates.length > 0) {
    const lines = candidates.slice(0, 4).map((m) => {
      const t = m.target;
      const why: string[] = [];
      if (!m.node.visible || !t.visible) why.push("not visible");
      if (!t.enabled) why.push("disabled");
      if (sel.clickable && m.via !== "hitArea" && !isClickableType(t.type)) {
        why.push("not clickable (it is a label, with no button or mouse area around it)");
      }
      if (sel.editable && !isEditableType(m.node.type) && !isEditableType(t.type)) why.push("does not accept text");
      return `    ${t.type} — ${why.length ? why.join(", ") : "excluded by a filter"}`;
    });
    const anyHidden = candidates.some((m) => !m.node.visible || !m.target.visible);
    const anyDisabled = candidates.some((m) => !m.target.enabled);
    const advice = anyHidden
      ? "It probably needs a preceding step to reveal it (or pass include_hidden: true)."
      : anyDisabled
        ? "It is on screen but disabled — the app may still be busy; try wait_for first."
        : "Narrow or relax the selector.";
    return `\n  ${candidates.length} element(s) carry that text but were excluded:\n${lines.join("\n")}\n  ${advice}`;
  }

  if ((sel.match ?? "exact") === "exact") {
    const relaxed = resolveAll(snapshot, { ...sel, match: "contains", includeHidden: true });
    if (relaxed.length > 0) {
      return (
        `\n  A substring match would have found ${relaxed.length}: ` +
        relaxed.slice(0, 3).map((m) => JSON.stringify(m.node.text)).join(", ") +
        `\n  Use { text: ${JSON.stringify(sel.text)}, match: contains } if that is what you meant.`
      );
    }
  }

  const near = suggest(sel.text, snapshot.labels(true));
  return near.length > 0 ? `\n  Did you mean: ${near.map((s) => JSON.stringify(s)).join(", ")}?` : "";
}

function describe(sel: Selector): string {
  const bits: string[] = [];
  if (sel.text !== undefined) bits.push(`text ${JSON.stringify(sel.text)} (${sel.match ?? "exact"})`);
  if (sel.objectName !== undefined) bits.push(`objectName ${JSON.stringify(sel.objectName)}`);
  if (sel.type !== undefined) bits.push(`type ~ ${sel.type}`);
  if (sel.clickable) bits.push("clickable");
  if (sel.editable) bits.push("editable");
  return bits.join(" + ") || "(empty selector)";
}

/** Cheap edit-distance ranking so a typo or a curly quote still gets a hint. */
function suggest(needle: string, labels: string[], limit = 4): string[] {
  const want = normaliseText(needle).toLowerCase();
  if (!want) return [];
  return labels
    .filter((l) => normaliseText(l).toLowerCase() !== want)
    .map((l) => ({ l, d: distance(want, normaliseText(l).toLowerCase()) }))
    .filter((x) => x.d <= Math.max(3, Math.floor(want.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.l);
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (b.includes(a) || a.includes(b)) return 1;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length]!;
}
