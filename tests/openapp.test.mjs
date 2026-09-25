// Opening an app: an app has two names and they do different jobs.
//
// The sidebar shows `display_name`; the dock is named after the module. Passing
// one string as both is why `sitometres init <app>` followed by
// `sitometres run <generated spec>` — the documented start-here workflow —
// could never pass its own first step for any app that sets a display_name.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Runner } from "../dist/runner/runner.js";
import { LogBuffer } from "../dist/logs/buffer.js";
import { describeDependencyBlock, findQmlRoot, openApp, OpenError } from "../dist/runner/open.js";

const ZONESCAN = { name: "zonescan_lite", display_name: "ZoneScan Lite", type: "ui_qml", dependencies: [] };
const PLAIN = { name: "tip_jar", type: "ui_qml", dependencies: [] };

/**
 * A fake inspector that records what the open path asked for, and only ever
 * admits to a dock whose objectName is the MODULE name — which is the one
 * thing Basecamp actually guarantees.
 */
function fakeSession(moduleName) {
  const asked = { clicked: [], objectNames: [] };
  const logs = new LogBuffer();
  return {
    asked,
    logs,
    inspector: {
      findAndClick: async (label) => {
        asked.clicked.push(label);
        return {};
      },
      findByProperty: async (prop, value) => {
        asked.objectNames.push(value);
        return value === moduleName ? { matches: [{ id: "dock-1" }] } : { matches: [] };
      },
      getTree: async () => ({ tree: { id: "dock-1", type: "Item", children: [] } }),
      evaluate: async () => ({ result: true, undefined: false }),
      textInventory: async () => [],
    },
  };
}

const runner = (session, manifest, open) =>
  new Runner({
    session,
    spec: { app: manifest.name, timeout: "15s", steps: [{ name: "opens", open }] },
    appName: manifest.name,
    manifest,
    logsUsable: false,
  });

test("open: accepts the display label and waits for the MODULE's dock", async () => {
  // Exactly what `init` writes for this app.
  const session = fakeSession("zonescan_lite");
  const result = await runner(session, ZONESCAN, "ZoneScan Lite").run();

  assert.equal(result.verdict, "pass", "the generated spec must pass its own first step");
  assert.ok(
    session.asked.objectNames.every((n) => n === "zonescan_lite"),
    `the dock is matched on the module name, never the label — asked for ${session.asked.objectNames}`,
  );
  assert.ok(session.asked.clicked.includes("ZoneScan Lite"), "and the sidebar is clicked by its label");
});

test("open: accepts the module name too", async () => {
  const session = fakeSession("zonescan_lite");
  const result = await runner(session, ZONESCAN, "zonescan_lite").run();
  assert.equal(result.verdict, "pass");
});

test("open: on a name that is neither spelling fails, naming both", async () => {
  const session = fakeSession("zonescan_lite");
  const result = await runner(session, ZONESCAN, "not_an_app").run();
  assert.equal(result.verdict, "fail");
  assert.match(result.steps[0].error, /zonescan_lite/);
  assert.match(result.steps[0].error, /ZoneScan Lite/);
});

// --- apps staged with `with:` ------------------------------------------------

const WALLET = { name: "medusa_ui", display_name: "Medusa", type: "ui_qml", view: "qml/Main.qml", dependencies: [] };
const CORE = { name: "medusa_core", type: "core", dependencies: [] };
const STAGED = [
  { manifest: PLAIN, slot: "plugins", artifact: "/stage/tip_jar" },
  { manifest: WALLET, slot: "plugins", artifact: "/stage/medusa_ui" },
  { manifest: CORE, slot: "modules", artifact: "/stage/medusa_core" },
];
const stagedRunner = (session, open) =>
  new Runner({
    session,
    spec: { app: "tip_jar", timeout: "15s", steps: [{ name: "opens", open }] },
    appName: "tip_jar",
    manifest: PLAIN,
    apps: STAGED,
    logsUsable: false,
  });

test("open: a staged `with:` app by its display label", async () => {
  // A dApp spec used to be refused here because the spec's app is tip_jar.
  const session = fakeSession("medusa_ui");
  const result = await stagedRunner(session, "Medusa").run();
  assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
  assert.deepEqual(session.asked.clicked, ["Medusa"], "the sidebar entry is clicked by its label");
  assert.ok(session.asked.objectNames.every((n) => n === "medusa_ui"), "and the dock is the module's");
  assert.equal(result.steps[0].app, "medusa_ui");
});

test("open: a staged core module fails at once, without waiting out the open budget", async () => {
  const session = fakeSession("medusa_core");
  const started = Date.now();
  const result = await stagedRunner(session, "medusa_core").run();
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms; the open floor is 45s`);
  assert.equal(result.verdict, "fail");
  assert.match(result.steps[0].error, /medusa_core, a core module with no UI/);
  assert.deepEqual(session.asked.clicked, [], "nothing was clicked for it");
});

test("a name no staged app answers to lists every staged UI app, by both spellings", async () => {
  const session = fakeSession("tip_jar");
  const result = await stagedRunner(session, "not_an_app").run();
  assert.equal(result.verdict, "fail");
  assert.match(result.steps[0].error, /It can name: tip_jar, medusa_ui \("Medusa"\)\./);
  assert.doesNotMatch(result.steps[0].error, /medusa_core/, "a core module is not an app you can open");
});

test("an app with no display_name still works, as it always did", async () => {
  const session = fakeSession("tip_jar");
  assert.equal((await runner(session, PLAIN, "tip_jar").run()).verdict, "pass");
});

test("a short step timeout does not shrink the budget for opening", async () => {
  // `init` writes a per-step timeout; opening is not the step's work. With the
  // step budget passed through, the click window consumed the whole deadline
  // and the launcher-API fallback never got a turn at any setting.
  let attempts = 0;
  const session = fakeSession("zonescan_lite");
  const slow = {
    ...session.inspector,
    findByProperty: async (prop, value) => {
      attempts++;
      // Not there for the first stretch, as a heavyweight module would be.
      if (attempts < 4) return { matches: [] };
      return value === "zonescan_lite" ? { matches: [{ id: "dock-1" }] } : { matches: [] };
    },
  };
  const r = new Runner({
    session: { ...session, inspector: slow },
    spec: { app: "zonescan_lite", timeout: "1s", steps: [{ name: "opens", open: "ZoneScan Lite" }] },
    appName: "zonescan_lite",
    manifest: ZONESCAN,
    logsUsable: false,
  });
  assert.equal((await r.run()).verdict, "pass", "a 1s step timeout must not cap the open");
});

// --- the launcher fallback, and the hint a failed open leaves behind ---------
//
// None of what follows was reached by any test. That is the whole path that
// runs when the sidebar delegate never renders — asking Basecamp's launcher
// what it knows, prodding its stalled metadata fetch, opening the app through
// backend.onAppLauncherClicked — plus every sentence of the hint a user reads
// when nothing opened at all. That hint is the entire output of a failed open
// and it makes checkable factual claims ("The plugin IS staged at …",
// "prodding it to refresh 2 time(s)"), so an untested one is the tool
// asserting things about a run nobody verified it did.

const MODULE = ZONESCAN.name;
const LABEL = ZONESCAN.display_name;
const clickFailed = (name) => `no visible item matching "${name}"`;

const REAL_NOW = Date.now;

/**
 * Freeze the clock; the fake inspector below is the only thing that moves it.
 *
 * Opening an app has a 45s floor (MIN_OPEN_MS) and polls with real sleeps, so
 * a test of any failure path would otherwise sit there for three quarters of a
 * minute. Every loop in openApp is bounded by Date.now arithmetic, so charging
 * `stepMs` of virtual time for each inspector round-trip is what decides how
 * many polls a run makes — and it decides it identically on a loaded machine
 * and an idle one, which a wall-clock test of these paths cannot.
 */
function frozenClock(stepMs) {
  let now = REAL_NOW();
  Date.now = () => now;
  return { tick: () => (now += stepMs), restore: () => (Date.now = REAL_NOW) };
}

/** A dock holding just the app: the QQuickWidget wrapper and the app's root. */
const APP_TREE = {
  id: "dock-1",
  type: "QDockWidget",
  children: [{ id: "quick", type: "QQuickWidget", children: [{ id: "root", type: "Panel_QMLTYPE_17", children: [] }] }],
};

/** The same dock, with the title bar's own QML type sitting ahead of the app's
 *  root — which is why the manifest's `view` has to reach findQmlRoot. */
const CHROME_TREE = {
  ...APP_TREE,
  children: [{ id: "chrome", type: "DockTitleBar_QMLTYPE_3", children: [] }, ...APP_TREE.children],
};

/**
 * A Basecamp that is up, but whose sidebar never grows our app's delegate.
 *
 * `launcher` is what backend.launcherApps reports, or null for "the sidebar's
 * QML does not exist yet"; the two are different answers and openApp treats
 * them differently. Every method charges the frozen clock before answering.
 */
function stalledBasecamp(over = {}) {
  const o = {
    stepMs: 3000,
    launcher: null,
    backendId: "backend-3",
    clickLands: () => false,
    findByTypeFails: () => false,
    dockAppears: () => true,
    tree: APP_TREE,
    labels: [],
    inventoryFails: false,
    ...over,
  };
  const clock = frozenClock(o.stepMs);
  // `refreshes` is every refresh that reached Basecamp, by either route: the
  // sidebar's `backend` (both builds) or the MainUIBackend object (0.2.2 only).
  const seen = { clicks: [], evaluated: [], methods: [], docks: [], types: [], refreshes: [] };
  const inspector = {
    findAndClick: async (text) => {
      clock.tick();
      seen.clicks.push(text);
      if (!o.clickLands(seen)) throw new Error(clickFailed(text));
      return { clicked: text };
    },
    findByType: async (typeName) => {
      clock.tick();
      seen.types.push(typeName);
      if (o.findByTypeFails(seen.types.length, typeName)) throw new Error("findByType timed out after 5000ms");
      if (typeName === "SidebarPanel") return { matches: o.launcher === null ? [] : [{ id: "sidebar-7" }] };
      if (typeName === "MainUIBackend") return { matches: o.backendId ? [{ id: o.backendId }] : [] };
      return { matches: [] };
    },
    evaluate: async (expression, objectId) => {
      clock.tick();
      seen.evaluated.push([expression, objectId]);
      if (expression.includes("launcherApps")) return { result: JSON.stringify(o.launcher ?? []) };
      if (o.activateFails && expression.includes("onAppLauncherClicked")) throw new Error("evaluate timed out after 5000ms");
      if (/backend\.refresh/.test(expression)) {
        if (o.sidebarRefreshFails) throw new Error("TypeError: Property 'refreshUiModules' of object is not a function");
        seen.refreshes.push(["sidebar", objectId, expression]);
      }
      return { result: 1 };
    },
    callMethod: async (objectId, method, args) => {
      clock.tick();
      seen.methods.push([objectId, method, args]);
      // An older build has refreshUiModules and no refreshRepositories.
      if (method === "refreshRepositories") throw new Error(`no such method ${method}`);
      seen.refreshes.push(["MainUIBackend", objectId, method]);
      return { invoked: method };
    },
    findByProperty: async (property, value) => {
      clock.tick();
      seen.docks.push([property, value]);
      return o.dockAppears(seen) && value === MODULE ? { matches: [{ id: "dock-1" }] } : { matches: [] };
    },
    getTree: async () => {
      clock.tick();
      return { tree: o.tree };
    },
    textInventory: async () => {
      clock.tick();
      if (o.inventoryFails) throw new Error("findByProperty timed out after 5000ms");
      return o.labels.map((text, i) => ({ id: `label-${i}`, type: "QLabel", text }));
    },
  };
  return { clock, seen, inspector };
}

/**
 * openApp on a fake that cannot open the app; hands back the error it threw.
 *
 * `timeoutMs: 1000` is below MIN_OPEN_MS on purpose, and passed without
 * `explicit`, the way the startup --timeout reaches an open: every hint below
 * says "over 45s", which is the floor doing its job for a budget nobody chose
 * for the open. An explicit budget is honoured as given; see the tests after
 * these.
 */
async function openFails(inspector, opts = {}) {
  try {
    await openApp(inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0, ...opts });
  } catch (err) {
    return err;
  }
  throw new Error("openApp resolved, but nothing in this fake can open the app");
}

test("the launcher API opens the app when the sidebar delegate never renders", async () => {
  // Both halves of this conversation are QML expressions evaluated against the
  // SidebarPanel, the one object with `backend` in scope; against any other
  // object they fail silently and the app just never opens. So the expressions
  // and the object they run against are asserted verbatim.
  const { clock, seen, inspector } = stalledBasecamp({
    // Our app's launcher entry carries only `moduleName`, the other only
    // `name`. Both spellings are in Basecamp's model, and reading only one of
    // them turns a present app into "Basecamp does not have an app called …":
    // the OTHER app still makes the list non-empty, and therefore trusted.
    launcher: [{ moduleName: MODULE }, { name: "tip_jar" }],
  });
  try {
    const scope = await openApp(inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });

    assert.deepEqual(seen.evaluated, [
      ["JSON.stringify(backend.launcherApps)", "sidebar-7"],
      [`backend.onAppLauncherClicked("${MODULE}"), 1`, "sidebar-7"],
    ]);
    assert.deepEqual([...new Set(seen.clicks)], [LABEL, MODULE], "the real click is preferred, and tried under both names");
    assert.equal(scope.dockId, "dock-1");
    assert.equal(scope.scopeId, "root", "and the scope is the app's QML root, not the dock frame");
  } finally {
    clock.restore();
  }
});

test("a launcher that lists other apps but not this one fails at once, naming what it does offer", async () => {
  const { clock, inspector } = stalledBasecamp({ stepMs: 8000, launcher: [{ name: "mapview" }, { name: "tip_jar" }] });
  try {
    const err = await openFails(inspector);
    assert.ok(err instanceof OpenError, `expected an OpenError, got ${err}`);
    assert.equal(err.name, "OpenError");
    assert.equal(err.message, `Basecamp does not have an app called "${MODULE}"`);
    assert.equal(err.hint, "Its launcher offers: mapview, tip_jar. Check the name in your manifest.json.");
  } finally {
    clock.restore();
  }
});

test("an empty launcher is not evidence of absence — Basecamp is prodded, and the click retried", async () => {
  // The plugin list is empty for the whole of startup, and the fetch that fills
  // it is not retried by Basecamp when it times out. Reading empty as "your app
  // is not installed" fails a perfectly good app; leaving it alone waits for a
  // list that will never arrive. So: ask again, then keep clicking.
  //
  // Asked through the sidebar's `backend`, the way the launcher itself is
  // read. This is the 0.3.0 shape: its MainUIBackend has no parent, so it is
  // not in the inspector's tree (backendId: null) and the object route that
  // 0.2.2 allowed finds nothing to call.
  const { clock, seen, inspector } = stalledBasecamp({
    launcher: [],
    backendId: null,
    clickLands: (s) => s.refreshes.length > 0,
  });
  try {
    const scope = await openApp(inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });

    assert.deepEqual(
      seen.refreshes,
      [
        ["sidebar", "sidebar-7", "backend.refreshUiModules(), 1"],
        ["sidebar", "sidebar-7", "backend.refreshRepositories(), 1"],
      ],
      "both no-argument slots, evaluated against the SidebarPanel, where `backend` is in scope",
    );
    assert.deepEqual(seen.methods, [], "no object had to be found for it");
    assert.equal(scope.dockId, "dock-1");
    assert.equal(seen.clicks.at(-1), LABEL, "the click that finally landed is the label the sidebar shows");
  } finally {
    clock.restore();
  }
});

test("with no sidebar to ask through, the MainUIBackend object is prodded instead (0.2.2)", async () => {
  // The sidebar's QML may not exist yet; 0.2.2 parents its MainUIBackend, so
  // the object can still be found and its slots invoked directly. The second
  // slot missing on an older build is not fatal.
  const { clock, seen, inspector } = stalledBasecamp({
    launcher: null,
    clickLands: (s) => s.refreshes.length > 0,
  });
  try {
    const scope = await openApp(inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });
    assert.deepEqual(seen.methods, [
      ["backend-3", "refreshUiModules", []],
      ["backend-3", "refreshRepositories", []],
    ]);
    assert.deepEqual(seen.refreshes, [["MainUIBackend", "backend-3", "refreshUiModules"]]);
    assert.equal(scope.dockId, "dock-1");
  } finally {
    clock.restore();
  }
});

test("a sidebar whose backend cannot refresh falls back to the MainUIBackend object", async () => {
  const { clock, seen, inspector } = stalledBasecamp({
    stepMs: 1000,
    launcher: [],
    sidebarRefreshFails: true,
    clickLands: (s) => s.refreshes.length > 0,
  });
  try {
    await openApp(inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });
    assert.deepEqual(seen.refreshes, [["MainUIBackend", "backend-3", "refreshUiModules"]]);
  } finally {
    clock.restore();
  }
});

test("a query the inspector cannot answer is a question unasked, not a failed open", async () => {
  // Every findByType on this path is wrapped in .catch(() => null), and it has
  // to be: the inspector has a per-command deadline, and a busy Basecamp times
  // one out now and then. Letting that reject ends the run with the
  // inspector's plumbing error in place of the diagnosis, and blames the last
  // thing that failed rather than the click that never landed.
  const { clock, seen, inspector } = stalledBasecamp({ stepMs: 8000, findByTypeFails: () => true });
  try {
    const err = await openFails(inspector);
    assert.equal(err.message, `could not open "${MODULE}"`);
    assert.equal(
      err.hint,
      `Tried clicking "${LABEL}" and "${MODULE}", asking Basecamp's launcher directly, and prodding it to ` +
        `refresh 0 time(s) over 45s. Last error: ${clickFailed(MODULE)}`,
      "the timed-out query is not the last error, and it did not count as a refresh",
    );
    assert.deepEqual(
      seen.types,
      ["SidebarPanel", "SidebarPanel", "MainUIBackend"],
      "the launcher, then both routes to a refresh, were asked for, and none answered",
    );
  } finally {
    clock.restore();
  }
});

test("an activation that does not go through is retried rather than surrendered to", async () => {
  // The launcher listed the app, so it is there; if onAppLauncherClicked cannot
  // be reached this pass — the sidebar was queried once and gone the next
  // instant, or the query timed out — the app is still openable, and the loop
  // still has budget. Treating a failed activation as final gives up on an app
  // Basecamp had just confirmed it has.
  const { clock, seen, inspector } = stalledBasecamp({
    launcher: [{ name: MODULE }],
    // The second findByType is activateViaBackend's; the first is the one
    // launcherApps made a moment earlier, and it was answered.
    findByTypeFails: (n) => n === 2,
    clickLands: (s) => s.refreshes.length > 0,
  });
  try {
    const scope = await openApp(inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });
    assert.equal(scope.dockId, "dock-1", "the app still opened, on the pass after the one that could not activate it");
    assert.deepEqual(
      seen.evaluated.filter(([expr]) => !expr.startsWith("backend.refresh")),
      [["JSON.stringify(backend.launcherApps)", "sidebar-7"]],
      "the activation expression never ran: there was no sidebar id that pass to run it against",
    );
    assert.equal(seen.clicks.at(-1), LABEL, "the click is what got there in the end");
  } finally {
    clock.restore();
  }
});

test("the failure hint counts the refreshes that actually happened and nothing else", async (t) => {
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), "sito-openapp-"));
  t.after(() => fs.rmSync(staged, { recursive: true, force: true }));
  fs.writeFileSync(path.join(staged, "manifest.json"), "{}");
  // Two labels are dropped: the empty one carries nothing, and the long one is
  // a sentence rather than a control. Twelve is the cap.
  const labels = [
    "Loading Package Manager…",
    "",
    "Preparing your workspace — this can take a while on a first run",
    "Ready",
    ...Array.from({ length: 12 }, (_, i) => `Tool ${i + 1}`),
  ];

  const prodded = stalledBasecamp({ stepMs: 8000, launcher: [], labels });
  try {
    const err = await openFails(prodded.inspector, { stagedAt: staged });
    assert.equal(err.message, `could not open "${MODULE}"`);
    assert.equal(
      err.hint,
      `Tried clicking "${LABEL}" and "${MODULE}", asking Basecamp's launcher directly, and prodding it to ` +
        `refresh 1 time(s) over 45s. ` +
        `The plugin IS staged at ${staged} (manifest.json), so this is Basecamp not listing it rather than a ` +
        `staging failure — the reason will be in the log above. ` +
        `Basecamp's sidebar is still on "Loading Package Manager…", i.e. its launcher never finished populating. ` +
        `That chain runs through package_manager and package_downloader; a getCatalog that cannot reach the ` +
        `network is the usual cause, and it is not retried on its own. ` +
        `Visible labels: "Loading Package Manager…", "Ready", "Tool 1", "Tool 2", "Tool 3", "Tool 4", "Tool 5", ` +
        `"Tool 6", "Tool 7", "Tool 8", "Tool 9", "Tool 10". ` +
        `Last error: ${clickFailed(MODULE)}`,
    );
    assert.equal(
      prodded.seen.refreshes.filter(([, , what]) => what.includes("refreshUiModules")).length,
      1,
      "the 1 in the hint is a count of refreshes that happened, not a guess",
    );
  } finally {
    prodded.clock.restore();
  }

  // 0.3.0's MainUIBackend is not in the tree at all, and that no longer stops
  // the prod: the sidebar's `backend` reaches the same slots.
  const noBackendObject = stalledBasecamp({ stepMs: 8000, launcher: [], backendId: null });
  try {
    const err = await openFails(noBackendObject.inspector, { stagedAt: staged });
    assert.match(err.hint, /asking Basecamp's launcher directly, and prodding it to refresh 1 time\(s\) over 45s\. /);
    assert.deepEqual(noBackendObject.seen.methods, [], "through the sidebar, not an object that is not there");
  } finally {
    noBackendObject.clock.restore();
  }

  // With neither a sidebar nor a MainUIBackend, nothing can be prodded, and the
  // hint has to say zero rather than take credit for a refresh that never ran.
  const unproddable = stalledBasecamp({ stepMs: 8000, launcher: null, backendId: null });
  try {
    const err = await openFails(unproddable.inspector, { stagedAt: staged });
    assert.match(err.hint, /asking Basecamp's launcher directly, and prodding it to refresh 0 time\(s\) over 45s\. /);
    assert.deepEqual(unproddable.seen.refreshes, [], "nothing was invoked, so nothing may be claimed");
  } finally {
    unproddable.clock.restore();
  }
});

test("a failed open says which half of the staging problem you have", async (t) => {
  // The sentence a user acts on. Files present means Basecamp did not list what
  // is already there and the reason is in the log; files absent means staging
  // never happened and it is ours to fix. They send you to opposite ends of the
  // problem, so the wrong one costs an afternoon.
  const full = fs.mkdtempSync(path.join(os.tmpdir(), "sito-openapp-full-"));
  for (const f of ["manifest.json", "main.qml", "icon.png", "README.md", "styles.qml", "helper.js", "extra.txt"]) {
    fs.writeFileSync(path.join(full, f), "x");
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sito-openapp-empty-"));
  t.after(() => {
    for (const dir of [full, empty]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const never = path.join(empty, "not", "here");
  // stepMs is large enough that the whole budget goes on the click window, so
  // these runs never get as far as the launcher — and the preamble, asserted
  // verbatim below, is the hint declining to claim a step that did not run.
  const preamble = `Tried clicking "${LABEL}" and "${MODULE}" over 45s. `;

  const present = stalledBasecamp({ stepMs: 25_000 });
  try {
    const err = await openFails(present.inspector, { stagedAt: full });
    assert.ok(err.hint.startsWith(`${preamble}The plugin IS staged at ${full} (`), `hint was: ${err.hint}`);
    const listed = err.hint.slice(err.hint.indexOf("(") + 1, err.hint.indexOf(")")).split(", ");
    assert.equal(listed.length, 6, "a directory listing is a hint, not an inventory — six names, then stop");
    for (const name of listed) assert.ok(fs.existsSync(path.join(full, name)), `${name} is really in the directory`);
    assert.ok(
      err.hint.endsWith(
        `), so this is Basecamp not listing it rather than a staging failure — the reason will be in the log ` +
          `above. Last error: ${clickFailed(MODULE)}`,
      ),
      `hint was: ${err.hint}`,
    );
  } finally {
    present.clock.restore();
  }

  const blank = stalledBasecamp({ stepMs: 25_000 });
  try {
    const err = await openFails(blank.inspector, { stagedAt: empty });
    assert.equal(
      err.hint,
      `${preamble}The plugin directory ${empty} is EMPTY, so staging failed. Last error: ${clickFailed(MODULE)}`,
    );
  } finally {
    blank.clock.restore();
  }

  const absent = stalledBasecamp({ stepMs: 25_000 });
  try {
    const err = await openFails(absent.inspector, { stagedAt: never });
    assert.equal(
      err.hint,
      `${preamble}The plugin was not staged to ${never}. Last error: ${clickFailed(MODULE)}`,
      "an unreadable path is its own answer, and must not be reported as an empty directory",
    );
  } finally {
    absent.clock.restore();
  }
});

test("an inspector that cannot list what is on screen still gets an honest hint", async () => {
  // textInventory is the best-effort extra; when it fails the hint loses the
  // labels section and keeps the diagnosis, rather than the open failing with
  // the inventory's error instead of its own.
  const { clock, inspector } = stalledBasecamp({ stepMs: 25_000, inventoryFails: true });
  try {
    const err = await openFails(inspector);
    assert.equal(
      err.hint,
      `Tried clicking "${LABEL}" and "${MODULE}" over 45s. Last error: ${clickFailed(MODULE)}`,
      "no labels section, no claim about the launcher, and the click error preserved",
    );
  } finally {
    clock.restore();
  }
});

/**
 * The remedy a dock that never appears ends on. It names the open's own budget,
 * in all three places it can be set: --timeout reaches the open only as a
 * floored fallback, so raising it can do nothing when a spec sets
 * `open_timeout:`.
 */
const SLOW_TO_START =
  "A heavyweight module can be slow to start. If it just needs longer, raise the open's budget: " +
  "`timeout:` on the `open:` step, `open_timeout:` in the spec, or --open-timeout.";

test("a click that lands but opens no dock names the route it used", async () => {
  // Which route opened the app decides what you look at next: a click that
  // landed on nothing is a sidebar problem, the launcher API returning without
  // a dock is the module failing to start. The hint must not guess.
  const clicked = stalledBasecamp({ stepMs: 25_000, clickLands: () => true, dockAppears: () => false });
  try {
    const err = await openFails(clicked.inspector);
    assert.equal(err.message, `"${MODULE}" did not open within 45s`);
    assert.equal(
      err.hint,
      `Opened via a click on "${LABEL}", but no dock with objectName "${MODULE}" ever appeared. ` +
        SLOW_TO_START,
    );
    assert.deepEqual(clicked.seen.docks, [["objectName", MODULE]], "the dock is only ever looked up by objectName");
  } finally {
    clicked.clock.restore();
  }

  const viaApi = stalledBasecamp({ stepMs: 6000, launcher: [{ name: MODULE }], dockAppears: () => false });
  try {
    const err = await openFails(viaApi.inspector);
    assert.equal(
      err.hint,
      `Opened via Basecamp's launcher API, but no dock with objectName "${MODULE}" ever appeared. ` +
        SLOW_TO_START,
      "no click ever landed here, so the hint may not say one did",
    );
  } finally {
    viaApi.clock.restore();
  }
});

// --- a budget written for the open is honoured as written ---------------------
//
// The floor above exists for budgets nobody chose for the open: the default,
// and the startup --timeout reaching it for compatibility. A budget someone
// wrote for the open (the `open:` step's own `timeout:`, `open_timeout:`,
// --open-timeout) is the author saying how long this app may take, and it used
// to be either ignored (the step's) or impossible to write (the other two).

test("an explicit open budget is honoured as given, below the floor too", async () => {
  const clicked = stalledBasecamp({ stepMs: 400, clickLands: () => true, dockAppears: () => false });
  try {
    const err = await openFails(clicked.inspector, { timeoutMs: 2000, explicit: true });
    assert.equal(err.message, `"${MODULE}" did not open within 2s`);
    assert.equal(err.hint, `Opened via a click on "${LABEL}", but no dock with objectName "${MODULE}" ever appeared. ${SLOW_TO_START}`);
  } finally {
    clicked.clock.restore();
  }
});

test("a short explicit budget still leaves the launcher fallback its turn", async () => {
  // The click window is a third of the budget when that is less than 15 s. At a
  // fixed 15 s, a 6 s budget went entirely on clicking a delegate that never
  // rendered, which is the trap the 45 s floor was invented for.
  const { clock, seen, inspector } = stalledBasecamp({ stepMs: 500, launcher: [{ name: MODULE }] });
  try {
    const scope = await openApp(inspector, MODULE, LABEL, { timeoutMs: 6000, explicit: true, settleMs: 0 });
    assert.equal(scope.dockId, "dock-1");
    assert.ok(
      seen.evaluated.some(([expr]) => expr.includes("onAppLauncherClicked")),
      "it opened through Basecamp's launcher API, inside six seconds",
    );
  } finally {
    clock.restore();
  }
});

/** Run one `open:` step through the Runner against a fake that never docks; hand back its error. */
async function openStepFails(spec, opts = {}) {
  const { clock, inspector } = stalledBasecamp({ stepMs: 25_000, clickLands: () => true, dockAppears: () => false });
  try {
    const r = new Runner({
      session: { inspector, logs: new LogBuffer() },
      spec: { app: MODULE, ...spec },
      appName: MODULE,
      manifest: ZONESCAN,
      logsUsable: false,
      onNote: () => {},
      ...opts,
    });
    const result = await r.run();
    assert.equal(result.steps[0].verdict, "fail");
    return result.steps[0].error;
  } finally {
    clock.restore();
  }
}

test("an open step's own timeout is the open's budget; the spec's timeout never is", async () => {
  // The step timeout used to be passed to openApp and never read.
  assert.match(
    await openStepFails({ timeout: "1s", steps: [{ open: LABEL, timeout: "4s" }] }),
    /did not open within 4s/,
  );
  assert.match(
    await openStepFails({ timeout: "1s", steps: [{ open: LABEL }] }),
    /did not open within 120s/,
    "a spec-level timeout is every step's budget, and a short one would make opening unpassable",
  );
});

test("open_timeout in the spec and --open-timeout are honoured; --timeout is a floored fallback", async () => {
  assert.match(await openStepFails({ openTimeout: "3s", steps: [{ open: LABEL }] }), /did not open within 3s/);
  assert.match(
    await openStepFails({ openTimeout: "3s", steps: [{ open: LABEL, timeout: "5s" }] }),
    /did not open within 5s/,
    "the step's own timeout is more specific than the spec's open_timeout",
  );
  assert.match(
    await openStepFails({ steps: [{ open: LABEL }] }, { openTimeoutMs: 2000, openTimeoutExplicit: true }),
    /did not open within 2s/,
  );
  assert.match(
    await openStepFails({ openTimeout: "3s", steps: [{ open: LABEL }] }, { openTimeoutMs: 2000, openTimeoutExplicit: true }),
    /did not open within 3s/,
    "the spec's open_timeout wins over the command line's",
  );
  assert.match(
    await openStepFails({ steps: [{ open: LABEL }] }, { openTimeoutMs: 2000 }),
    /did not open within 45s/,
    "--timeout was written for startup, so the open keeps its floor",
  );
});

test("the manifest's view names the app's own root inside a dock that also holds chrome", async () => {
  const declared = stalledBasecamp({ clickLands: () => true, tree: CHROME_TREE });
  try {
    const scope = await openApp(declared.inspector, MODULE, LABEL, {
      timeoutMs: 1000,
      settleMs: 0,
      view: "qml/Panel.qml",
    });
    assert.equal(scope.qmlRootId, "root", "the declared view, directory and extension stripped, identifies the root");
    assert.equal(scope.scopeId, "root", "so state: and eval: run against the app and not against the dock's title bar");
  } finally {
    declared.clock.restore();
  }

  const undeclared = stalledBasecamp({ clickLands: () => true, tree: CHROME_TREE });
  try {
    const scope = await openApp(undeclared.inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });
    assert.equal(scope.qmlRootId, "chrome", "without it the first QML type in the dock wins — here, the title bar's");
  } finally {
    undeclared.clock.restore();
  }
});

test("a view whose name means something to a regular expression does not crash the open", () => {
  // `view` is a string out of the app's own manifest.json, and it is
  // interpolated into the type-name pattern. Unescaped, a bracket is not a
  // near-miss: new RegExp("^Main[_QMLTYPE_") throws, and the SyntaxError comes
  // out of openApp in place of an opened app.
  assert.equal(findQmlRoot(CHROME_TREE, "Panel.qml"), "root");
  assert.equal(
    findQmlRoot(CHROME_TREE, "Main[.qml"),
    "chrome",
    "it matches nothing, so it falls back to the one QML type in the dock — it does not throw",
  );
});

// --- Basecamp 0.3.0's launcher -------------------------------------------------

test("the 'never finished populating' paragraph follows the launcher, not the placeholder label", async () => {
  // "Loading Package Manager…" is a placeholder page that is in the tree on
  // both builds whether the launcher filled or not, so it was attached to
  // every failed open. The launcher itself says whether it is empty.
  const labels = ["Loading Package Manager…", "Settings"];
  const listed = stalledBasecamp({ stepMs: 8000, launcher: [{ name: MODULE }], activateFails: true, labels });
  try {
    const err = await openFails(listed.inspector);
    assert.doesNotMatch(err.hint, /never finished populating/, "the launcher answered, and it lists the app");
    assert.match(err.hint, /Visible labels: "Loading Package Manager…", "Settings"\./);
  } finally {
    listed.clock.restore();
  }

  const empty = stalledBasecamp({ stepMs: 8000, launcher: [], labels: ["Settings"] });
  try {
    const err = await openFails(empty.inspector);
    assert.match(err.hint, /its launcher never finished populating/, "asked, and empty every time, with no label to go on");
  } finally {
    empty.clock.restore();
  }
});

test("an app 0.3.0's launcher marks as blocked by its dependencies says so when no dock appears", async () => {
  // 0.3.0 checks an app's dependencies before loading it and shows a popup
  // instead, so the click lands and no dock ever comes. Its launcher row
  // (UIPluginManager::buildAppRow) carries the reason.
  const blocked = stalledBasecamp({
    stepMs: 25_000,
    launcher: [{ name: MODULE, hasMissingDeps: true, depBlockKind: "mismatch" }],
    clickLands: () => true,
    dockAppears: () => false,
  });
  try {
    const err = await openFails(blocked.inspector);
    assert.equal(err.message, `"${MODULE}" did not open within 45s`);
    assert.match(err.hint, new RegExp(`Basecamp's launcher marks ${MODULE} as blocked: a dependency it declares is installed at a version outside the declared range \\(depBlockKind "mismatch"\\)`));
    assert.match(err.hint, /Stage the dependency with --with <name>/);
    assert.doesNotMatch(err.hint, /slow to start/, "the reason is known, so the timeout advice is not given");
  } finally {
    blocked.clock.restore();
  }

  // 0.2.2's rows carry neither field: nothing to say, and the old advice stands.
  assert.equal(describeDependencyBlock({ name: MODULE }), "");
  assert.equal(describeDependencyBlock(undefined), "");
  assert.equal(describeDependencyBlock({ name: MODULE, hasMissingDeps: false }), "");
  assert.match(describeDependencyBlock({ name: MODULE, hasMissingDeps: true }), /its dependencies are missing or mismatched/);
});

test("a launcher read that itself fails when no dock appears is not fatal — the generic timeout advice still prints", async () => {
  // The click lands immediately here, so openApp never asks the launcher on
  // its way in — launcherApps(inspector) is called for the first and only
  // time once the dock-wait times out, to explain WHY. Deleting findByType
  // makes that one call reject (a missing method throws before `.catch` can
  // even attach to a promise), which openApp must absorb exactly like an
  // empty or absent launcher: fall back to the generic advice instead of
  // throwing something unrelated.
  const s = stalledBasecamp({
    stepMs: 25_000,
    launcher: [{ name: MODULE, hasMissingDeps: true }],
    clickLands: () => true,
    dockAppears: () => false,
  });
  delete s.inspector.findByType;
  try {
    const err = await openFails(s.inspector);
    assert.equal(err.message, `"${MODULE}" did not open within 45s`);
    assert.match(
      err.hint,
      /A heavyweight module can be slow to start/,
      "launcherApps failing is swallowed, same as it finding nothing to say",
    );
  } finally {
    s.clock.restore();
  }
});

/** A Basecamp whose sidebar delegates carry 0.3.0's `sidebar.app.<module>` objectName, or not. */
function sidebarWithObjectNames(withObjectName) {
  const seen = { clickedRefs: [], clickedText: [] };
  const inspector = {
    findByProperty: async (property, value) => {
      if (property !== "objectName") return { matches: [] };
      if (withObjectName && value === `sidebar.app.${MODULE}`) return { matches: [{ id: "delegate-4" }] };
      if (value === MODULE) return { matches: [{ id: "dock-1" }] };
      return { matches: [] };
    },
    clickRef: async (id) => {
      seen.clickedRefs.push(id);
      return { clicked: true };
    },
    findAndClick: async (text) => {
      seen.clickedText.push(text);
      return { clicked: text };
    },
    getTree: async () => ({ tree: APP_TREE }),
    evaluate: async () => ({ result: 1 }),
    findByType: async () => ({ matches: [] }),
    textInventory: async () => [],
  };
  return { seen, inspector };
}

test("the sidebar entry is clicked by its 0.3.0 objectName first, and by its label on 0.2.2", async () => {
  // The objectName cannot be confused with another app that shares a display
  // name, or with the same words elsewhere in the window.
  const v030 = sidebarWithObjectNames(true);
  const scope = await openApp(v030.inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });
  assert.equal(scope.dockId, "dock-1");
  assert.deepEqual(v030.seen.clickedRefs, ["delegate-4"]);
  assert.deepEqual(v030.seen.clickedText, [], "no label click was needed");

  const v022 = sidebarWithObjectNames(false);
  await openApp(v022.inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });
  assert.deepEqual(v022.seen.clickedRefs, [], "no such objectName on 0.2.2");
  assert.deepEqual(v022.seen.clickedText, [LABEL], "so the label the sidebar shows is clicked, as before");
});
