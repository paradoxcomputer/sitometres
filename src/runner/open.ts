// ---------------------------------------------------------------------------
// Opening an app and working out what "inside the app" means.
//
// Basecamp gives the plugin's QDockWidget objectName == the module name
// (WorkspaceArea::addPluginDock), which is the handle that scopes selectors to
// one app — necessary because docks are hidden rather than destroyed, so every
// other open plugin's labels stay in the global tree.
//
// But the dock is a frame, not the app: its title bar carries a label with the
// module's name, so a crawl scoped to the dock "discovers" a control called
// "medusa_ui" that is really the window title. The app's own UI starts at the
// QQuickWidget inside it, and its QML root is the object that `state:`
// expressions must evaluate against. We resolve all three and hand back the
// tightest scope that exists.
// ---------------------------------------------------------------------------

import fs from "node:fs";

import { type InspectorClient, sleep } from "../inspector/client.js";
import type { TreeNode } from "../inspector/protocol.js";
import { status } from "../report/status.js";
import { DEFAULT_OPEN_SETTLE_MS, DEFAULT_OPEN_TIMEOUT_MS, describeSeconds } from "../timeouts.js";

export interface AppScope {
  /** The QDockWidget. Present whenever the app opened at all. */
  dockId: string;
  /** The app's own QML root, when it could be found. */
  qmlRootId: string | null;
  /** Tightest sensible root for selectors: the QML root, else the QQuickWidget,
   *  else the dock. Excludes the dock's title-bar chrome when possible. */
  scopeId: string;
}

/**
 * How long to keep trying the real click before falling back to the API, at
 * most. A third of the open budget when that is less, so however short a
 * budget someone chose, the launcher fallback still gets a turn.
 */
const CLICK_WINDOW_MS = 15_000;

/**
 * The least time an open is given when nobody chose its budget.
 *
 * Only the default and the startup --timeout, which reaches the open for
 * compatibility, are floored. A budget written for the open itself (its step's
 * `timeout:`, `open_timeout:`, --open-timeout) is honoured exactly: that is
 * the author saying how long this app may take.
 */
const MIN_OPEN_MS = 45_000;

/** The click window for an open budget: see CLICK_WINDOW_MS. */
export function clickWindowFor(budgetMs: number): number {
  return Math.min(CLICK_WINDOW_MS, budgetMs / 3);
}

/** How an app is opened: the budget, and whether someone chose it. */
export interface OpenOptions {
  /** Total budget for the open. Infinity means no deadline. */
  timeoutMs?: number;
  /**
   * True when `timeoutMs` was chosen for this open, and is honoured as given.
   * Otherwise it is a fallback and never goes below MIN_OPEN_MS.
   */
  explicit?: boolean;
  /** The pause for the first paint once the dock exists. Default 1.2 s. */
  settleMs?: number;
  stagedAt?: string;
  view?: string;
}

/** How often to re-ask Basecamp for its plugin list while it stays empty. */
const REFRESH_EVERY_MS = 10_000;

/**
 * One app as Basecamp's launcher describes it. 0.3.0 adds whether its
 * dependencies block it: `depBlockKind` is Basecamp's own summary ("absent",
 * "mismatch", "signer" or "mixed"), empty when nothing blocks it.
 */
export interface LauncherApp {
  name: string;
  hasMissingDeps?: boolean;
  depBlockKind?: string;
}

/**
 * The apps Basecamp's launcher currently knows about, or null if we could not
 * ask (no sidebar QML yet). Distinguishes "your app is missing" from "the
 * sidebar has not finished loading".
 */
async function launcherApps(inspector: InspectorClient): Promise<LauncherApp[] | null> {
  const sidebar = (await inspector.findByType("SidebarPanel").catch(() => null))?.matches?.[0];
  if (!sidebar) return null;
  try {
    const res = await inspector.evaluate("JSON.stringify(backend.launcherApps)", sidebar.id);
    const parsed = JSON.parse(String(res.result ?? "[]")) as Array<Record<string, unknown>>;
    const out: LauncherApp[] = [];
    for (const a of parsed) {
      const name = String(a.name ?? a.moduleName ?? "");
      if (!name) continue;
      const row: LauncherApp = { name };
      if (typeof a.hasMissingDeps === "boolean") row.hasMissingDeps = a.hasMissingDeps;
      if (typeof a.depBlockKind === "string" && a.depBlockKind.length > 0) row.depBlockKind = a.depBlockKind;
      out.push(row);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * What 0.3.0's launcher says about an app its dependencies block, or "".
 *
 * Basecamp 0.3.0 checks an app's core dependencies before it loads it, and
 * shows a popup instead of the app when one is missing or outside the
 * declared range, so no dock ever appears. 0.2.2 has no such gate and its
 * launcher rows carry neither field, so this is always "" there.
 */
export function describeDependencyBlock(row: LauncherApp | undefined): string {
  if (!row || (row.hasMissingDeps !== true && row.depBlockKind === undefined)) return "";
  const kind: Record<string, string> = {
    absent: "a dependency it declares is not installed",
    missing: "a dependency it declares is not installed",
    mismatch: "a dependency it declares is installed at a version outside the declared range",
    signer: "a dependency it declares is signed by someone other than the declared signer",
    mixed: "several of its dependencies are missing or at the wrong version",
  };
  const what = (row.depBlockKind && kind[row.depBlockKind]) ?? "its dependencies are missing or mismatched";
  return (
    `Basecamp's launcher marks ${row.name} as blocked: ${what}` +
    `${row.depBlockKind ? ` (depBlockKind "${row.depBlockKind}")` : ""}. Basecamp 0.3.0 shows a popup ` +
    `instead of opening an app like that. Stage the dependency with --with <name>, at a version the ` +
    `manifest accepts. `
  );
}

/**
 * Ask Basecamp to re-run its plugin-metadata fetch.
 *
 * The launcher is filled by an async chain through package_manager and
 * package_downloader. When one of those calls times out (a getCatalog that
 * cannot reach the network is the usual culprit) the chain is NOT retried,
 * and the sidebar sits on "Loading Package Manager…" forever. Nothing will
 * change unless something asks again, so we ask.
 *
 * Through the sidebar's `backend` context property first, the same way the
 * launcher itself is reached: 0.3.0 creates its MainUIBackend without a
 * parent (app/window.cpp), so it is not in the inspector's object tree at all
 * and a findByType for it finds nothing. Both builds expose the two slots on
 * `backend`. The MainUIBackend object is the fallback, for a build whose
 * sidebar is not up yet; `refreshUiModules` takes no arguments, which is why
 * callMethod can reach it there (the inspector marshals every argument as
 * Q_ARG(QVariant, …) and would fail on a typed parameter).
 */
async function retryMetadataFetch(inspector: InspectorClient): Promise<boolean> {
  const slots = ["refreshUiModules", "refreshRepositories"];
  const sidebar = (await inspector.findByType("SidebarPanel").catch(() => null))?.matches?.[0];
  if (sidebar) {
    let asked = false;
    for (const slot of slots) {
      try {
        await inspector.evaluate(`backend.${slot}(), 1`, sidebar.id);
        asked = true;
      } catch {
        /* a slot missing on this build is not fatal */
      }
    }
    if (asked) return true;
  }
  const backend = (await inspector.findByType("MainUIBackend").catch(() => null))?.matches?.[0];
  if (!backend) return false;
  let asked = false;
  for (const slot of slots) {
    try {
      await inspector.callMethod(backend.id, slot, []);
      asked = true;
    } catch {
      /* a slot missing on this build is not fatal */
    }
  }
  return asked;
}

/**
 * Click an app's sidebar entry by its objectName, when the build gives it one.
 *
 * 0.3.0 names each launcher delegate `sidebar.app.<module>`, which cannot be
 * confused with another app that happens to share a display name, or with
 * the same words elsewhere in the window. 0.2.2 has no such objectName, so a
 * miss here is normal and the caller falls back to the label.
 */
async function clickSidebarEntry(inspector: InspectorClient, moduleName: string): Promise<boolean> {
  let id: string | undefined;
  try {
    id = (await inspector.findByProperty("objectName", `sidebar.app.${moduleName}`))?.matches?.[0]?.id;
  } catch {
    return false;
  }
  if (!id) return false;
  try {
    await inspector.clickRef(String(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Open an app through Basecamp's own launcher slot.
 *
 * `callMethod` cannot reach it — the inspector marshals every argument as
 * Q_ARG(QVariant, …) and the slot takes a QString, so invokeMethod refuses —
 * but a QML expression can.
 */
async function activateViaBackend(inspector: InspectorClient, moduleName: string): Promise<boolean> {
  const sidebar = (await inspector.findByType("SidebarPanel").catch(() => null))?.matches?.[0];
  if (!sidebar) return false;
  try {
    await inspector.evaluate(`backend.onAppLauncherClicked(${JSON.stringify(moduleName)}), 1`, sidebar.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * The app's own QML root inside its dock.
 *
 * Qt names the type after the FILE — `Main.qml` becomes `Main_QMLTYPE_42` — so
 * matching `Main_QMLTYPE_` hardcoded a filename convention that Basecamp does
 * not impose: it `setSource()`s whatever `view` the manifest declares. For an
 * app whose entry file is called anything else the root was never found, every
 * `state:` check went INCONCLUSIVE with a detail naming no cause, and `eval:`
 * silently evaluated in global scope instead of in the app. README and SKILL
 * both call `state:` the family that "works on every build" and the place to
 * put load-bearing checks, so this was the documented advice failing quietly.
 *
 * The declared view is tried first, then any single QML type in the dock.
 */
export function findQmlRoot(tree: TreeNode, view?: string): string | null {
  const base = view ? view.replace(/\.qml$/i, "").split("/").pop() : undefined;
  if (base) {
    const exact = findFirst(tree, (n) => new RegExp(`^${escapeRe(base)}_QMLTYPE_`).test(String(n.type ?? "")));
    if (exact) return exact;
  }
  // Fallback: the dock holds exactly one app, so any QMLTYPE in it is that app's
  // — better than reporting "no root" and disabling every state: check.
  return findFirst(tree, (n) => /_QMLTYPE_\d/.test(String(n.type ?? "")));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The options every command should open an app with.
 *
 * They had drifted: `init` passed none at all, `inspect` passed only stagedAt,
 * the spec runner passed only a timeout. So the same failure produced a
 * different diagnosis depending on which command hit it, and --timeout was
 * honoured by some and ignored by others.
 *
 * `budget` is the open's time budget and whether someone chose it for the
 * open; see openBudgetFrom in ../timeouts.ts and Runner.openBudget.
 */
export function openOptionsFor(
  app: { manifest: { view?: string }; slot: string } | null,
  userDirRoot: string | undefined,
  appName: string,
  budget: { timeoutMs?: number; explicit?: boolean } = {},
): OpenOptions {
  const out: OpenOptions = {};
  if (budget.timeoutMs !== undefined) {
    out.timeoutMs = budget.timeoutMs;
    if (budget.explicit) out.explicit = true;
  }
  if (userDirRoot && app) out.stagedAt = `${userDirRoot}/${app.slot}/${appName}`;
  if (app?.manifest.view) out.view = app.manifest.view;
  return out;
}

export class OpenError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "OpenError";
  }
}

/**
 * Click an app's sidebar entry and wait for its dock to appear.
 *
 * `label` is what the sidebar shows (metadata's display_name, falling back to
 * the module name); `moduleName` is what the dock's objectName will be. They
 * differ whenever an app sets display_name — zonescan_lite shows as
 * "ZoneScan Lite" but docks as "zonescan_lite".
 */
export async function openApp(
  inspector: InspectorClient,
  moduleName: string,
  label: string,
  opts: OpenOptions = {},
): Promise<AppScope> {
  // A floor for a budget nobody chose for the open. A spec's step timeout used
  // to be passed straight through, and `init` writes `timeout: 15s`, which was
  // exactly the click window below, so the launcher-API fallback never got a
  // single turn and the generated spec could not pass its own first step at
  // any setting. Opening an app is not the step's work, so a spec-level
  // `timeout:` never reaches here at all. A budget written for the open is
  // honoured as given, and the click window shrinks with it instead.
  const timeoutMs = opts.explicit && opts.timeoutMs !== undefined
    ? opts.timeoutMs
    : Math.max(opts.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS, MIN_OPEN_MS);
  // Every wait below is a Date.now() comparison, not a timer, so "none"
  // (Infinity) simply never expires.
  const deadline = Date.now() + timeoutMs;

  // The sidebar is populated asynchronously — Basecamp is still awaiting
  // package_manager's getInstalledPackages and package_downloader's getCatalog
  // when the shell first renders — so a single click loses a race it did not
  // know it was in. Keep trying until the entry exists.
  //
  // Both names are tried because the sidebar labels an app with its
  // display_name while the dock is named after the module: zonescan_lite shows
  // as "ZoneScan Lite". Whichever the delegate actually carries, one of these
  // matches.
  status.set("Running", `clicking "${label}" in the sidebar`);
  const names = [...new Set([label, moduleName])];

  // Prefer a real click: that is the gesture a user makes, and it exercises the
  // sidebar delegate. But the launcher is populated asynchronously and can stall
  // outright — a hung package_downloader getCatalog leaves the sidebar stuck on
  // "Loading Package Manager…" indefinitely — so we do not let an unrelated
  // network stall decide whether the app under test can be opened.
  let clicked = false;
  let via: "click" | "backend" = "click";
  let lastError = "";

  /**
   * One attempt at the real click: the objectName 0.3.0 gives the delegate,
   * then each name the delegate might show. True when one landed.
   */
  const tryClick = async (): Promise<boolean> => {
    if (typeof (inspector as Partial<InspectorClient>).clickRef === "function" && (await clickSidebarEntry(inspector, moduleName))) {
      return true;
    }
    for (const name of names) {
      try {
        await inspector.findAndClick(name);
        return true;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    return false;
  };

  const clickDeadline = Math.min(deadline, Date.now() + clickWindowFor(timeoutMs));
  while (Date.now() < clickDeadline) {
    if (await tryClick()) {
      clicked = true;
      break;
    }
    await sleep(250);
  }

  let refreshes = 0;
  let askedLauncher = false;
  let nextRefreshAt = Date.now();
  /** What the launcher said the last time it answered; null while it never has. */
  let lastLauncher: LauncherApp[] | null = null;
  while (!clicked && Date.now() < deadline) {
    // Ask Basecamp directly whether it knows the app, and open it if so.
    // `backend` is a context property of the sidebar's QML, so an expression
    // evaluated against SidebarPanel can reach it.
    status.set("Running", `sidebar has not rendered "${label}" — asking Basecamp`);
    askedLauncher = true;
    const rows = await launcherApps(inspector);
    if (rows !== null) lastLauncher = rows;
    const registered = rows?.map((r) => r.name) ?? null;

    // An EMPTY launcher is not evidence of absence: the plugin list arrives
    // asynchronously and is empty for the whole of startup. Only a populated
    // launcher that lacks our module proves the app is really not there.
    if (registered !== null && registered.length > 0 && !registered.includes(moduleName)) {
      throw new OpenError(
        `Basecamp does not have an app called "${moduleName}"`,
        `Its launcher offers: ${registered.join(", ")}. Check the name in your manifest.json.`,
      );
    }
    if (registered !== null && registered.includes(moduleName)) {
      if (await activateViaBackend(inspector, moduleName)) {
        clicked = true;
        via = "backend";
        break;
      }
    }
    // Still loading. Left alone this never resolves, because the timed-out
    // fetch is not retried by Basecamp — so prod it, at a slow cadence.
    if (Date.now() >= nextRefreshAt) {
      nextRefreshAt = Date.now() + REFRESH_EVERY_MS;
      status.set("Running", `Basecamp's app list is still empty — asking it to refresh (${refreshes + 1})`);
      if (await retryMetadataFetch(inspector)) refreshes++;
    }

    // Keep trying the click too; whichever wins is fine.
    if (await tryClick()) clicked = true;
    if (!clicked) await sleep(500);
  }

  if (!clicked) {
    const visible = await inspector.textInventory().catch(() => []);
    const nearby = visible.map((v) => v.text).filter((t) => t.length > 0 && t.length < 40).slice(0, 12);
    // "Never finished populating" is what the launcher itself says: asked, and
    // empty every time. The "Loading Package Manager" label is not evidence of
    // it, since that placeholder page is in the tree on every build whether the
    // launcher filled or not. Only when the launcher could not be asked at all
    // does the label still count, as the best evidence there is.
    const neverPopulated = lastLauncher !== null
      ? lastLauncher.length === 0
      : nearby.some((n) => /Loading .*Package Manager/i.test(n));
    throw new OpenError(
      `could not open "${moduleName}"`,
      // Only the steps that actually ran. Claiming the launcher was asked when
      // the deadline expired first — and reporting "0 refreshes" for refreshes
      // that never happened — is the tool overstating its own evidence, which
      // is the one thing it exists not to do.
      `Tried clicking ${names.map((n) => JSON.stringify(n)).join(" and ")}` +
        (askedLauncher
          ? `, asking Basecamp's launcher directly, and prodding it to refresh ${refreshes} time(s)`
          : "") +
        ` over ${describeSeconds(timeoutMs)}. ` +
        describeStagedState(opts.stagedAt) +
        describeDependencyBlock(lastLauncher?.find((r) => r.name === moduleName)) +
        (neverPopulated
          ? `Basecamp's sidebar is still on "Loading Package Manager…", i.e. its launcher never finished populating. ` +
            `That chain runs through package_manager and package_downloader; a getCatalog that cannot reach the ` +
            `network is the usual cause, and it is not retried on its own. `
          : "") +
        (nearby.length ? `Visible labels: ${nearby.map((n) => JSON.stringify(n)).join(", ")}. ` : "") +
        `Last error: ${lastError}`,
    );
  }

  const deadline2 = deadline;
  let dockId: string | null = null;
  const waitStart = Date.now();
  while (Date.now() < deadline2) {
    status.set("Running", `waiting for ${moduleName} to open (${Math.round((Date.now() - waitStart) / 1000)}s)`);
    const found = await inspector.findByProperty("objectName", moduleName);
    if (found.matches?.[0]) {
      dockId = found.matches[0].id;
      break;
    }
    await sleep(200);
  }
  if (!dockId) {
    // 0.3.0 answers a click on an app its dependencies block with a popup
    // instead of a dock, and its launcher row says so. One question, asked
    // only now that the open has failed; 0.2.2's rows carry no such field.
    const blocked = describeDependencyBlock((await launcherApps(inspector).catch(() => null))?.find((r) => r.name === moduleName));
    throw new OpenError(
      `"${moduleName}" did not open within ${describeSeconds(timeoutMs)}`,
      `Opened via ${via === "click" ? `a click on "${label}"` : "Basecamp's launcher API"}, ` +
        `but no dock with objectName "${moduleName}" ever appeared. ` +
        (blocked ||
          `A heavyweight module can be slow to start. If it just needs longer, raise the open's budget: ` +
            `\`timeout:\` on the \`open:\` step, \`open_timeout:\` in the spec, or --open-timeout.`),
    );
  }

  status.set("Running", `${moduleName} opened — letting the first paint settle`);
  await sleep(opts.settleMs ?? DEFAULT_OPEN_SETTLE_MS);

  return (await locateScope(inspector, moduleName, opts.view, dockId))!;
}

/**
 * Find an already-open app's dock, root and selector scope.
 *
 * The tail of openApp, on its own so a scope can be found again without
 * clicking anything: a spec that evaluates in another app's root holds that
 * root's id from when the app was opened, and if the app's QML reloaded since,
 * the id is stale. Null when no dock carries the module's name.
 *
 * `dockId` skips the lookup when the caller has just found the dock itself.
 */
export async function locateScope(
  inspector: InspectorClient,
  moduleName: string,
  view?: string,
  dockId?: string,
): Promise<AppScope | null> {
  let dock = dockId ?? null;
  if (!dock) {
    const found = await inspector.findByProperty("objectName", moduleName);
    dock = found.matches?.[0]?.id ?? null;
  }
  if (!dock) return null;
  const { tree } = await inspector.getTree({ objectId: dock, depth: 10 });
  const qmlRootId = findQmlRoot(tree, view);
  const quickWidgetId = findFirst(tree, (n) => String(n.type ?? "").includes("QQuickWidget"));

  return {
    dockId: dock,
    qmlRootId,
    scopeId: qmlRootId ?? quickWidgetId ?? dock,
  };
}

/**
 * State plainly whether the plugin actually reached the user-dir.
 *
 * This is the fact that splits the two very different causes: files missing
 * means staging went wrong and is ours to fix; files present but unlisted means
 * Basecamp did not load them, and the run log is where the reason is.
 */
/**
 * What the staged directory looks like, for the open-failure hint.
 *
 * Callers must pass the path stageUserDir actually wrote to —
 * `<root>/<slot>/<name>` — not `<root>/plugins/<name>`. Hardcoding "plugins"
 * gave a core module a confidently false diagnosis: "The plugin was not staged
 * to …", about a directory that was never supposed to exist.
 */
function describeStagedState(stagedAt: string | undefined): string {
  if (!stagedAt) return "";
  try {
    const entries = fs.readdirSync(stagedAt);
    return entries.length > 0
      ? `The plugin IS staged at ${stagedAt} (${entries.slice(0, 6).join(", ")}), so this is Basecamp not listing it rather than a staging failure — the reason will be in the log above. `
      : `The plugin directory ${stagedAt} is EMPTY, so staging failed. `;
  } catch {
    return `The plugin was not staged to ${stagedAt}. `;
  }
}

function findFirst(node: TreeNode, pred: (n: TreeNode) => boolean): string | null {
  if (pred(node)) return String(node.id);
  for (const child of (node.children as TreeNode[] | undefined) ?? []) {
    const hit = findFirst(child, pred);
    if (hit) return hit;
  }
  return null;
}
