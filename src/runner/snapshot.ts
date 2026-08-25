// ---------------------------------------------------------------------------
// A queryable picture of the UI at one instant.
//
// The inspector's own finders are too blunt to drive a real app:
//   * findByProperty matches values EXACTLY — no substring, no regex;
//   * findAndClick matches by substring and takes the first breadth-first hit,
//     so "Connect with Medusa" lands on the subtitle "A “Connect with Medusa”
//     SDK demo" rather than the button (observed, tip_jar);
//   * neither one checks visibility, so hidden controls are matched and
//     "clicked" — and tip_jar builds its whole UI out of `visible:`-bound
//     blocks, so most labels exist long before the user can see them;
//   * listInteractive IS visibility-aware but reports the Button's own `text`,
//     which is empty whenever the label lives on a nested contentItem — again
//     the common case (tip_jar's buttons all report text="").
//
// So we pull the subtree once with getTree and answer questions locally. It is
// cheap: the whole tip_jar dock at depth 60 came back in 8 ms.
// ---------------------------------------------------------------------------

import type { InspectorClient } from "../inspector/client.js";
import type { TreeNode } from "../inspector/protocol.js";
import { status } from "../report/status.js";

export interface UiNode {
  id: string;
  type: string;
  text: string;
  objectName: string;
  visible: boolean;
  enabled: boolean;
  geometry?: { x: number; y: number; width: number; height: number };
  /** Index into UiSnapshot.nodes, or -1 at the root. */
  parent: number;
  depth: number;
  /** Position in `nodes`, matching document (breadth-independent) order. */
  index: number;
}

/**
 * Class-name fragments that mark something a user can actually click.
 * Superset of the inspector's own allow-list; QML type names are mangled with
 * a `_QMLTYPE_n` suffix, so we match on fragments rather than equality.
 */
const CLICKABLE = [
  "Button", "Delegate", "MouseArea", "TapHandler", "TabButton", "MenuItem",
  "CheckBox", "RadioButton", "Switch", "ComboBox", "Slider", "SpinBox",
  "ItemDelegate", "ToolButton",
];

const EDITABLE = ["TextField", "TextInput", "TextEdit", "TextArea", "SpinBox", "ComboBox"];

/** Types that receive clicks without looking like a control themselves. */
const HANDLERS = ["MouseArea", "TapHandler"];

export type ClickVia = "self" | "ancestor" | "hitArea" | "fallback";

export function isHandlerType(type: string): boolean {
  return HANDLERS.some((frag) => type.includes(frag));
}

export function isClickableType(type: string): boolean {
  return CLICKABLE.some((frag) => type.includes(frag));
}

export function isEditableType(type: string): boolean {
  return EDITABLE.some((frag) => type.includes(frag));
}

export class UiSnapshot {
  private constructor(
    readonly nodes: UiNode[],
    /** Id of the subtree root this snapshot covers. */
    readonly scopeId: string | null,
    readonly capturedAtMs: number,
  ) {}

  /**
   * Pull a subtree. `scopeId` restricts to one app's dock, which is what makes
   * selectors unambiguous when several plugins are open at once — Basecamp
   * hides docks rather than destroying them, so every other open app's labels
   * are still in the global tree.
   */
  static async capture(inspector: InspectorClient, scopeId?: string, depth = 100): Promise<UiSnapshot> {
    const t0 = Date.now();
    status.detailOnly("reading the UI tree");
    const opts: { depth: number; objectId?: string } = { depth };
    if (scopeId) opts.objectId = scopeId;
    const { tree } = await inspector.getTree(opts);
    const nodes: UiNode[] = [];
    walk(tree, -1, 0, nodes);
    return new UiSnapshot(nodes, scopeId ?? null, Date.now() - t0);
  }

  byId(id: string): UiNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  parentOf(n: UiNode): UiNode | undefined {
    return n.parent >= 0 ? this.nodes[n.parent] : undefined;
  }

  ancestors(n: UiNode): UiNode[] {
    const out: UiNode[] = [];
    let cur = this.parentOf(n);
    while (cur) {
      out.push(cur);
      cur = this.parentOf(cur);
    }
    return out;
  }

  descendants(n: UiNode): UiNode[] {
    // Nodes are emitted depth-first, so a subtree is the contiguous run of
    // entries after `n` that are deeper than it.
    const out: UiNode[] = [];
    for (let i = n.index + 1; i < this.nodes.length; i++) {
      const c = this.nodes[i]!;
      if (c.depth <= n.depth) break;
      out.push(c);
    }
    return out;
  }

  /**
   * The thing to actually click for a given node.
   *
   * Two idioms cover almost every real control, and only one of them is an
   * ancestor relationship:
   *
   *   Button { contentItem: Text { text: "Send" } }        -> walk UP
   *   Rectangle { Text { text: "Send" }; MouseArea { … } } -> the handler is a
   *                                                           SIBLING of the label
   *
   * The second is what hand-rolled designs use — medusa_ui and zonescan_lite
   * are built almost entirely that way, and an ancestor-only search finds zero
   * clickable controls in them. So when no ancestor is clickable we climb again
   * looking for the nearest ancestor that CONTAINS a mouse handler, and target
   * that handler.
   */
  clickTargetFor(n: UiNode): { target: UiNode; via: ClickVia } {
    if (isClickableType(n.type)) return { target: n, via: "self" };

    const chain: UiNode[] = [];
    for (const a of this.ancestors(n)) {
      if (isClickableType(a.type)) return { target: a, via: "ancestor" };
      // Stop BEFORE the app root, not after. Including it let the hit-area scan
      // below search the entire app and return the first MouseArea anywhere —
      // so a caption resolved to an unrelated button, and every paragraph of
      // prose was queued as a control.
      if (a.type.includes("QQuickWidget") || a.type.includes("DockWidget")) break;
      chain.push(a);
    }

    // Nearest enclosing container with its own mouse handler wins. Searching
    // outward one level at a time keeps us from stealing a distant sibling's
    // handler: the first container that has one is the control the label is in.
    for (const a of chain) {
      const handler = this.descendants(a).find((d) => isHandlerType(d.type) && d.visible && d.enabled);
      if (handler) return { target: handler, via: "hitArea" };
    }

    return { target: n, via: "fallback" };
  }

  /**
   * Visible labels, tagged with what the text IS.
   *
   * Three states, because two were not enough and each two-state version was
   * wrong in a different direction:
   *
   *   control    the text names a control — the node IS one, or it is the
   *              contentItem of one. Revealing it is not the app reporting.
   *   message    the text resolves to no handler at all, so it is prose. This
   *              is the app talking, and the only thing that may drive
   *              `worked` or `failed`.
   *   ambiguous  the text is a SIBLING of a mouse handler in an enclosing
   *              container — the hand-rolled card idiom this file documents as
   *              how medusa_ui and zonescan_lite are built almost entirely. It
   *              might be the button's label ("Done") or a genuine message
   *              ("Transfer failed: insufficient funds"), and the tree is
   *              identical in both cases. Nothing can separate them, so the
   *              tool must not guess: counting these as confirmations reported
   *              success for a Done button, and counting them as control names
   *              silently discarded real failure messages.
   */
  labelsWithRole(includeHidden = false): Array<{ text: string; role: "control" | "message" | "ambiguous" }> {
    const rank = { control: 2, ambiguous: 1, message: 0 } as const;
    const seen = new Map<string, "control" | "message" | "ambiguous">();
    for (const n of this.nodes) {
      if (!n.text) continue;
      if (!includeHidden && !n.visible) continue;
      const via = this.clickTargetFor(n).via;
      // `ambiguous` uses its own, tighter test rather than reusing clickTargetFor's
      // hitArea result. That search climbs until it finds ANY container holding a
      // handler, which is right for deciding what to click — a label should still
      // reach its card — but far too loose for deciding what text means: in a real
      // dock the app root contains a handler somewhere, so every line of prose in
      // the app would resolve via hitArea and nothing could ever be read as a
      // message. Text is only ambiguous when a handler sits alongside it, in its
      // own parent or grandparent.
      const role =
        via === "self" || via === "ancestor"
          ? "control"
          : this.handlerBeside(n)
            ? "ambiguous"
            : "message";
      const prev = seen.get(n.text);
      // The same string can appear on more than one node; the strongest claim
      // wins, so a word that IS a control's name somewhere is never read as a
      // message elsewhere.
      if (prev === undefined || rank[role] > rank[prev]) seen.set(n.text, role);
    }
    return [...seen].map(([text, role]) => ({ text, role }));
  }

  /**
   * Is there a mouse handler close enough to this text to be its control?
   *
   * "Close" means the label's own parent or grandparent holds one directly —
   * the hand-rolled card shape. Anything further away is a layout that happens
   * to contain a control elsewhere, and its prose is prose.
   */
  private handlerBeside(n: UiNode): boolean {
    let level: UiNode | undefined = this.parentOf(n);
    for (let i = 0; i < 2 && level; i++) {
      const kids = this.descendants(level).filter((d) => d.depth === level!.depth + 1);
      if (kids.some((d) => isHandlerType(d.type) && d.visible && d.enabled)) return true;
      level = this.parentOf(level);
    }
    return false;
  }

  /** Every visible, non-empty label in scope — the basis for suggestions. */
  labels(includeHidden = false): string[] {
    const seen = new Set<string>();
    for (const n of this.nodes) {
      if (!n.text) continue;
      if (!includeHidden && !n.visible) continue;
      seen.add(n.text);
    }
    return [...seen];
  }
}

function walk(raw: TreeNode, parent: number, depth: number, out: UiNode[]): void {
  const geometry = raw.geometry as UiNode["geometry"] | undefined;
  const node: UiNode = {
    id: String(raw.id ?? ""),
    type: String(raw.type ?? "unknown"),
    text: typeof raw.text === "string" ? raw.text : "",
    objectName: typeof raw.objectName === "string" ? raw.objectName : "",
    // Absent means "not a visual item"; treat as visible so non-Item widgets
    // (QWidget wrappers) never mask their visible children.
    visible: raw.visible === undefined ? true : Boolean(raw.visible),
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    parent,
    depth,
    index: out.length,
  };
  if (geometry) node.geometry = geometry;
  out.push(node);
  const self = node.index;
  for (const child of (raw.children as TreeNode[] | undefined) ?? []) {
    walk(child, self, depth + 1, out);
  }
}
