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

export interface AppScope {
  /** The QDockWidget. Present whenever the app opened at all. */
  dockId: string;
  /** The app's own QML root, when it could be found. */
  qmlRootId: string | null;
  /** Tightest sensible root for selectors: the QML root, else the QQuickWidget,
   *  else the dock. Excludes the dock's title-bar chrome when possible. */
  scopeId: string;
}

/** How long to keep trying the real click before falling back to the API. */
const CLICK_WINDOW_MS = 15_000;

/**
 * The least time opening an app is ever given.
 *
 * Must exceed CLICK_WINDOW_MS, or the launcher-API fallback is unreachable.
 */
const MIN_OPEN_MS = 45_000;

/** How often to re-ask Basecamp for its plugin list while it stays empty. */
const REFRESH_EVERY_MS = 10_000;

/**
 * The apps Basecamp's launcher currently knows about, or null if we could not
 * ask (no sidebar QML yet). Distinguishes "your app is missing" from "the
 * sidebar has not finished loading".
 */
async function launcherApps(inspector: InspectorClient): Promise<string[] | null> {
  const sidebar = (await inspector.findByType("SidebarPanel").catch(() => null))?.matches?.[0];
  if (!sidebar) return null;
  try {
    const res = await inspector.evaluate("JSON.stringify(backend.launcherApps)", sidebar.id);
    const parsed = JSON.parse(String(res.result ?? "[]")) as Array<Record<string, unknown>>;
    return parsed.map((a) => String(a.name ?? a.moduleName ?? "")).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Ask Basecamp to re-run its plugin-metadata fetch.
 *
 * The launcher is filled by an async chain through package_manager and
 * package_downloader. When one of those calls times out — a getCatalog that
 * cannot reach the network is the usual culprit — the chain is NOT retried,
 * and the sidebar sits on "Loading Package Manager…" forever. Nothing will
 * change unless something asks again, so we ask.
 *
 * `refreshUiModules` takes no arguments, which is why callMethod can reach it:
 * the inspector marshals every argument as Q_ARG(QVariant, …) and would fail
 * on a typed parameter.
 */
async function retryMetadataFetch(inspector: InspectorClient): Promise<boolean> {
  const backend = (await inspector.findByType("MainUIBackend").catch(() => null))?.matches?.[0];
  if (!backend) return false;
  let asked = false;
  for (const slot of ["refreshUiModules", "refreshRepositories"]) {
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
 */
export function openOptionsFor(
  app: { manifest: { view?: string }; slot: string } | null,
  userDirRoot: string | undefined,
  appName: string,
  timeoutMs?: number,
): { timeoutMs?: number; stagedAt?: string; view?: string } {
  const out: { timeoutMs?: number; stagedAt?: string; view?: string } = {};
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
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
  opts: { timeoutMs?: number; settleMs?: number; stagedAt?: string; view?: string } = {},
): Promise<AppScope> {
  // A floor, not just a default. A spec step's timeout used to be passed
  // straight through, and `init` writes `timeout: 15s` — which is exactly the
  // click window below, so the launcher-API fallback never got a single turn
  // and the generated spec could not pass its own first step at any setting.
  // Opening an app is not the step's work; it is what has to happen before the
  // step can be attempted at all.
  const timeoutMs = Math.max(opts.timeoutMs ?? 120_000, MIN_OPEN_MS);
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

  const clickDeadline = Math.min(deadline, Date.now() + CLICK_WINDOW_MS);
  while (Date.now() < clickDeadline) {
    for (const name of names) {
      try {
        await inspector.findAndClick(name);
        clicked = true;
        break;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    if (clicked) break;
    await sleep(250);
  }

  let refreshes = 0;
  let askedLauncher = false;
  let nextRefreshAt = Date.now();
  while (!clicked && Date.now() < deadline) {
    // Ask Basecamp directly whether it knows the app, and open it if so.
    // `backend` is a context property of the sidebar's QML, so an expression
    // evaluated against SidebarPanel can reach it.
    status.set("Running", `sidebar has not rendered "${label}" — asking Basecamp`);
    askedLauncher = true;
    const registered = await launcherApps(inspector);

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
    for (const name of names) {
      try {
        await inspector.findAndClick(name);
        clicked = true;
        break;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    if (!clicked) await sleep(500);
  }

  if (!clicked) {
    const visible = await inspector.textInventory().catch(() => []);
    const nearby = visible.map((v) => v.text).filter((t) => t.length > 0 && t.length < 40).slice(0, 12);
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
        ` over ${Math.round(timeoutMs / 1000)}s. ` +
        describeStagedState(opts.stagedAt) +
        (nearby.some((n) => /Loading .*Package Manager/i.test(n))
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
    throw new OpenError(
      `"${moduleName}" did not open within ${Math.round(timeoutMs / 1000)}s`,
      `Opened via ${via === "click" ? `a click on "${label}"` : "Basecamp's launcher API"}, ` +
        `but no dock with objectName "${moduleName}" ever appeared. ` +
        `A heavyweight module can be slow to start — raise --timeout if it just needs longer.`,
    );
  }

  status.set("Running", `${moduleName} opened — letting the first paint settle`);
  await sleep(opts.settleMs ?? 1200);

  const { tree } = await inspector.getTree({ objectId: dockId, depth: 10 });
  const qmlRootId = findQmlRoot(tree, opts.view);
  const quickWidgetId = findFirst(tree, (n) => String(n.type ?? "").includes("QQuickWidget"));

  return {
    dockId,
    qmlRootId,
    scopeId: qmlRootId ?? quickWidgetId ?? dockId,
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
