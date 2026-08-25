// ---------------------------------------------------------------------------
// `sitometres inspect` — show the developer what their own app exposes.
//
// This is the answer to the flattest question in the whole workflow: "what can
// I even click?". The inspector's own listInteractive matches a fixed type
// allow-list and reports the control's own `text`, which is empty whenever the
// label sits on a nested contentItem — the normal case. So we walk the app's
// subtree ourselves, pair each clickable with the label a user would read, and
// print selectors that can be pasted straight into a spec.
// ---------------------------------------------------------------------------

import { uiLabel } from "../app/manifest.js";
import { explainOpenFailure, parseLine } from "../logs/classify.js";
import { boot, type BootOptions, type CommandDeps, REAL_DEPS } from "../session.js";
import { openApp, openOptionsFor, OpenError } from "../runner/open.js";
import { resolveAll } from "../runner/selector.js";
import { resolveSetupSpec, runSetupProfile } from "../runner/setup.js";
import { unlockWallet } from "../app/wallet.js";
import { isClickableType, isEditableType, UiSnapshot } from "../runner/snapshot.js";

// Same rule as every other reporter: honour a pipe and NO_COLOR. Painting
// unconditionally put escape codes in output the user had asked to be plain.
const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const DIM = colour ? "\x1b[2m" : "";
const RST = colour ? "\x1b[0m" : "";
const CY = colour ? "\x1b[36m" : "";
const BOLD = colour ? "\x1b[1m" : "";

export interface InspectOptions extends BootOptions {
  /** Also print labels that are present but not currently visible. */
  hidden?: boolean;
  json?: boolean;
  /** A setup profile to run before listing, so the gate is not what gets listed. */
  setup?: string;
  noSetup?: boolean;
}

export async function inspect(opts: InspectOptions = {}, deps: CommandDeps = REAL_DEPS): Promise<number> {
  const b = await deps.boot(opts);
  try {
    const appName = b.app?.manifest.name ?? null;
    let scopeId: string | undefined;

    if (appName) {
      try {
        const scope = await openApp(
          b.session.inspector,
          appName,
          uiLabel(b.app!.manifest),
          openOptionsFor(b.app, b.userDir?.root, appName, opts.timeoutMs),
        );
        scopeId = scope.scopeId;
        // Unlock, then walk the gate — in that order, and both of them for the
        // same reason: without either, this command lists the controls of a
        // lock screen and calls them the app's. `--wallet-password` was already
        // accepted here and documented as "unlock the wallet after opening the
        // app", and nothing read it: `unlockWallet` was called only by the crawl
        // and the spec runner, so the flag did nothing at all and said nothing.
        if (b.walletUnlock && scope.qmlRootId) {
          const why = await unlockWallet(
            b.session.inspector,
            scope.qmlRootId,
            b.walletUnlock.provider,
            b.walletUnlock.password,
          );
          if (why) console.error(`  could not unlock the wallet: ${why}`);
        }
        await runSetupProfile(
          b,
          resolveSetupSpec({ ...opts, quietNarration: opts.json }, appName, b.app?.artifact ?? null),
          appName,
          "listing",
          opts.json,
        );
      } catch (err) {
        const e = err as OpenError;
        console.error(`  ${e.message}`);
        const why = explainOpenFailure(b.session.logs.slice(0).map(parseLine), appName);
        if (why) for (const l of why.split("\n")) console.error(`    ${l}`);
        else if (e.hint) console.error(`    ${e.hint}`);
        return 1;
      }
    }

    const snap = await UiSnapshot.capture(b.session.inspector, scopeId);

    const clickables: Array<{ label: string; type: string; objectName: string; visible: boolean; selector: string }> = [];
    const fields: Array<{ type: string; objectName: string; visible: boolean; selector: string }> = [];
    const seen = new Set<string>();

    for (const node of snap.nodes) {
      if (node.text) {
        const { target, via } = snap.clickTargetFor(node);
        if ((via === "hitArea" || isClickableType(target.type)) && !seen.has(target.id)) {
          seen.add(target.id);
          // Ambiguity here is a spec-authoring problem, so surface the fix now.
          const uniqueByText = resolveAll(snap, { text: node.text, includeHidden: true }).length === 1;
          clickables.push({
            label: node.text,
            type: target.type,
            objectName: target.objectName || node.objectName,
            visible: node.visible && target.visible,
            selector: uniqueByText
              ? JSON.stringify(node.text)
              : `{ text: ${JSON.stringify(node.text)}, type: ${JSON.stringify(shortType(target.type))} }`,
          });
        }
      }
      if (isEditableType(node.type) && !seen.has(node.id)) {
        seen.add(node.id);
        // nth must index the selector's OWN matches, in the order resolveAll
        // ranks them — not this listing's array position, which counts other
        // types too and would produce a selector that resolves to nothing.
        // resolveAll excludes hidden nodes unless asked, so a hidden field is
        // not among its matches and findIndex returns -1. Emitting `nth: 0` for
        // that addressed the first VISIBLE field instead — a pasteable selector
        // that silently points at a different control. A hidden field must be
        // addressed with include_hidden, and its index taken from the list that
        // contains it.
        const peers = resolveAll(snap, {
          type: shortType(node.type),
          editable: true,
          ...(node.visible ? {} : { includeHidden: true }),
        });
        const nth = peers.findIndex((m) => m.node.id === node.id);
        const positional = node.visible
          ? `{ type: ${JSON.stringify(shortType(node.type))}, nth: ${nth} }`
          : `{ type: ${JSON.stringify(shortType(node.type))}, nth: ${nth}, include_hidden: true }`;
        fields.push({
          type: node.type,
          objectName: node.objectName,
          visible: node.visible,
          selector: node.objectName
            ? `{ objectName: ${JSON.stringify(node.objectName)} }`
            : nth < 0
              ? `{ objectName: "…" }   # no stable handle and not addressable positionally — add an objectName`
              : positional,
        });
      }
    }

    const visibleOnly = <T extends { visible: boolean }>(xs: T[]) => (opts.hidden ? xs : xs.filter((x) => x.visible));

    if (opts.json) {
      console.log(JSON.stringify({ app: appName, clickables, fields, labels: snap.labels(opts.hidden) }, null, 2));
      return 0;
    }

    console.log(`\n${BOLD}${appName ?? "Basecamp"}${RST} ${DIM}— ${snap.nodes.length} nodes${scopeId ? ", scoped to the app's dock" : ""}${RST}\n`);

    const cs = visibleOnly(clickables);
    console.log(`  ${BOLD}Clickable${RST} ${DIM}(${cs.length})${RST}`);
    if (cs.length === 0) console.log(`    ${DIM}none visible — the app may still be loading, or try --hidden${RST}`);
    for (const c of cs) {
      console.log(`    ${CY}${c.selector}${RST}${c.visible ? "" : `  ${DIM}(hidden)${RST}`}`);
      console.log(`      ${DIM}${c.type}${c.objectName ? `  objectName=${c.objectName}` : "  (no objectName)"}${RST}`);
    }

    const fs2 = visibleOnly(fields);
    console.log(`\n  ${BOLD}Text input${RST} ${DIM}(${fs2.length})${RST}`);
    if (fs2.length === 0) console.log(`    ${DIM}none${RST}`);
    for (const f of fs2) {
      console.log(`    ${CY}${f.selector}${RST}${f.visible ? "" : `  ${DIM}(hidden)${RST}`}`);
      console.log(`      ${DIM}${f.type}${f.objectName ? `  objectName=${f.objectName}` : "  (no objectName — add one to make this stable)"}${RST}`);
    }

    const noNames = [...cs, ...fs2].filter((x) => !x.objectName).length;
    if (noNames > 0) {
      console.log(
        `\n  ${DIM}${noNames} control(s) have no objectName. Selectors fall back to visible text, which breaks\n` +
          `  when the copy changes. Adding \`objectName: "sendButton"\` in your QML makes them stable.${RST}`,
      );
    }
    console.log("");
    return 0;
  } finally {
    await b.dispose();
  }
}

/** "Button_QMLTYPE_37" -> "Button", so generated selectors survive a rebuild. */
function shortType(type: string): string {
  return type.replace(/_QMLTYPE_\d+(_QML_\d+)?$/, "").replace(/^QQuick/, "");
}
