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
import { findQmlRoot, openApp, OpenError } from "../dist/runner/open.js";

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
  const seen = { clicks: [], evaluated: [], methods: [], docks: [], types: [] };
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
      return { result: 1 };
    },
    callMethod: async (objectId, method, args) => {
      clock.tick();
      seen.methods.push([objectId, method, args]);
      // An older build has refreshUiModules and no refreshRepositories.
      if (method === "refreshRepositories") throw new Error(`no such method ${method}`);
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
 * `timeoutMs: 1000` is below MIN_OPEN_MS on purpose: every hint below says
 * "over 45s", which is the floor doing its job.
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
  const { clock, seen, inspector } = stalledBasecamp({
    launcher: [],
    clickLands: (s) => s.methods.length > 0,
  });
  try {
    const scope = await openApp(inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });

    assert.deepEqual(
      seen.methods,
      [
        ["backend-3", "refreshUiModules", []],
        ["backend-3", "refreshRepositories", []],
      ],
      "both no-argument slots, on the MainUIBackend object — and the second one missing on this build is not fatal",
    );
    assert.equal(scope.dockId, "dock-1");
    assert.equal(seen.clicks.at(-1), LABEL, "the click that finally landed is the label the sidebar shows");
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
    assert.deepEqual(seen.types, ["SidebarPanel", "MainUIBackend"], "both were asked for, and neither answered");
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
    clickLands: (s) => s.methods.length > 0,
  });
  try {
    const scope = await openApp(inspector, MODULE, LABEL, { timeoutMs: 1000, settleMs: 0 });
    assert.equal(scope.dockId, "dock-1", "the app still opened, on the pass after the one that could not activate it");
    assert.deepEqual(
      seen.evaluated,
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
      prodded.seen.methods.filter(([, method]) => method === "refreshUiModules").length,
      1,
      "the 1 in the hint is a count of refreshes that happened, not a guess",
    );
  } finally {
    prodded.clock.restore();
  }

  // A build with no MainUIBackend cannot be prodded at all, and the hint has to
  // say zero rather than take credit for a refresh that never ran.
  const unproddable = stalledBasecamp({ stepMs: 8000, launcher: [], backendId: null });
  try {
    const err = await openFails(unproddable.inspector, { stagedAt: staged });
    assert.match(err.hint, /asking Basecamp's launcher directly, and prodding it to refresh 0 time\(s\) over 45s\. /);
    assert.deepEqual(unproddable.seen.methods, [], "nothing was invoked, so nothing may be claimed");
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
        `A heavyweight module can be slow to start — raise --timeout if it just needs longer.`,
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
        `A heavyweight module can be slow to start — raise --timeout if it just needs longer.`,
      "no click ever landed here, so the hint may not say one did",
    );
  } finally {
    viaApi.clock.restore();
  }
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
