// Where each time budget goes, checked from the outside.
//
// timeouts.test.mjs pins the grammar and what each budget resolves to. This
// file pins that the budgets arrive where they are spent. A flag or a spec key
// that resolves correctly and is then dropped on its way is the "flag that did
// nothing" defect, and six such drops once left the whole suite green: `run`
// forgetting the spec's startup_timeout, boot forgetting --command-timeout,
// the crawl forgetting the window it had learned.
//
// It also pins three things a review found behind correct-looking budgets:
// the settle, which an action that used up its step left at nothing, so a
// negative expectation passed before the forbidden call arrived; the startup
// gate, which waited for a log line some builds never print; and the commands
// outside any step (an open, a wallet unlock), which kept the stock 20 s
// window however long the log said the bridge would wait.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { boot, OutsideDeadline } from "../dist/session.js";
import { launch } from "../dist/app/lifecycle.js";
import { LogBuffer } from "../dist/logs/buffer.js";
import { Runner } from "../dist/runner/runner.js";
import { run } from "../dist/commands/run.js";
import { smoke } from "../dist/commands/smoke.js";
import { inspect } from "../dist/commands/inspect.js";
import { init, template } from "../dist/commands/init.js";
import { main } from "../dist/cli.js";
import { validateSpec } from "../dist/spec/schema.js";
import { timeoutFlagsOf } from "../dist/timeouts.js";

const FAKE = fileURLToPath(new URL("./helpers/fake-basecamp.mjs", import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const made = [];
const scratch = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
const booted = [];
test.after(async () => {
  for (const b of booted.splice(0)) {
    try {
      await b.dispose();
    } catch {
      /* already gone */
    }
  }
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** Run something with stdout/stderr collected rather than printed. */
async function quiet(fn) {
  const log = console.log;
  const err = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => out.push(a.join(" "));
  try {
    return { code: await fn(), out: out.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const DISPATCH = (ms, method = "listAccounts") =>
  `LogosAPIConsumer: Calling invokeRemoteMethod: "medusa_core" "${method}" args_count: 1 timeout: ${ms}`;

// --- an app in-process ----------------------------------------------------------

const DEMO = { name: "demo_ui", version: "0.1.0", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} };

/**
 * One app in one dock, with a Go and a Gate button, driven with no Basecamp.
 *
 * Clicking a control named in `late` makes `late.text` appear `late.after` ms
 * later: the effect of a posted click that lands after the click returned.
 * Every scoped command deadline is recorded in `scopes`.
 */
function plainApp({ late = {}, clickMs = 0, onOpen } = {}) {
  const logs = new LogBuffer();
  const scopes = [];
  const shown = new Set();
  const btn = (id, text) => ({ id, type: "Button_QMLTYPE_2", objectName: "", text, visible: true, enabled: true, children: [] });
  const tree = () => ({
    id: "window",
    type: "QMainWindow",
    visible: true,
    children: [
      { id: "side", type: "ItemDelegate_QMLTYPE_7", text: "demo_ui", visible: true, enabled: true, children: [] },
      {
        id: "dock", type: "QDockWidget", objectName: "demo_ui", visible: true,
        children: [{
          id: "qw", type: "QQuickWidget", visible: true,
          children: [{
            id: "root", type: "Main_QMLTYPE_3", visible: true,
            children: [
              btn("go", "Go"),
              btn("gate", "Gate"),
              ...[...shown].map((text, i) => ({ id: `late-${i}`, type: "Text", text, visible: true, enabled: true, children: [] })),
            ],
          }],
        }],
      },
    ],
  });
  const all = () => {
    const out = [];
    (function walk(n) {
      out.push(n);
      for (const c of n.children ?? []) walk(c);
    })(tree());
    return out;
  };
  const inspector = {
    findAndClick: async (label) => {
      if (!all().some((n) => n.text === label)) throw new Error(`No object found with text: ${label}`);
      onOpen?.(logs);
      return {};
    },
    findByType: async () => ({ matches: [] }),
    findByProperty: async (p, v) => ({ matches: all().filter((n) => n[p] === v).map((n) => ({ id: n.id })) }),
    getTree: async ({ objectId } = {}) => {
      const n = objectId ? all().find((x) => x.id === objectId) : tree();
      if (!n) throw new Error("Root object not found");
      return { tree: n };
    },
    evaluate: async (expression) => {
      if (expression.includes('"unlock"')) return { result: JSON.stringify({ ok: true }), undefined: false };
      return { result: true, undefined: false };
    },
    clickRef: async (id) => {
      if (clickMs > 0) await pause(clickMs);
      const effect = late[id];
      if (effect) setTimeout(() => {
        if (effect.text) shown.add(effect.text);
        if (effect.line) logs.append(effect.line, "stdout");
      }, effect.after);
      return {};
    },
    textInventory: async () => [],
    screenshot: async () => ({ image: "" }),
    withCommandTimeout: async (ms, fn) => {
      scopes.push(ms);
      return fn();
    },
  };
  return {
    scopes,
    session: { inspector, logs, logSource: { describe: () => "in-process" }, port: 41300, mode: "owned" },
  };
}

/** A boot that hands `run` the in-process app, recording what it was asked for. */
function stubBoot(app, seen = {}) {
  const discovered = {
    manifest: DEMO, slot: "plugins", artifact: "/w/demo_ui", form: "dir", built: true, origin: "/w/demo_ui",
    label: "demo_ui", builtAt: Date.now(), provenance: "local",
  };
  return {
    boot: async (opts) => {
      seen.opts = opts;
      return {
        session: app.session,
        ready: { portMs: 1, coreStartedMs: null, uiProbeMs: 1, modulesLoaded: [] },
        fidelity: { fidelity: "verbose", qtLogLines: 10, moduleLogLines: 0, summary: "Qt logging is on", remedy: "" },
        app: discovered,
        staged: [discovered],
        plan: null,
        stagedRecords: [],
        sandboxHome: null,
        appHome: null,
        walletSummary: null,
        walletUnlock: null,
        basecamp: { path: "/opt/LogosBasecamp", origin: "test", inspectorEnabled: true },
        userDir: { root: "/tmp/sitometres-x", foreign: [], replaced: [], restores: false, inPlace: [] },
        timeouts: timeoutFlagsOf(opts),
        dispose: async () => {},
      };
    },
  };
}

/** A spec file, and a profile beside it when one is given. */
function specFile(lines, profile) {
  const dir = scratch("sito-wiring-");
  const spec = path.join(dir, "spec.yaml");
  fs.writeFileSync(spec, [...lines, ""].join("\n"));
  let setup;
  if (profile) {
    setup = path.join(dir, "demo_ui.setup.yaml");
    fs.writeFileSync(setup, [...profile, ""].join("\n"));
  }
  return { dir, spec, setup };
}

const runner = (session, spec, extra = {}) =>
  new Runner({ session, spec, appName: "demo_ui", logsUsable: true, onNote: () => {}, ...extra });

// --- the settle is not what the action left of the step --------------------------

test("an action that spends its step's budget still leaves a negative check its settle", async () => {
  // The review's case: the click takes 400 ms under `timeout: 300ms`, and the
  // forbidden call is logged 300 ms after it returns. The expectation budget
  // was 0, the settle was capped by it, and the step passed in 402 ms.
  const call = 'LogosAPIClient: invoking remote method "demo_core" "deleteEverything" args_count: 0';
  const app = plainApp({ clickMs: 400, late: { go: { after: 300, line: call } } });
  const result = await runner(app.session, {
    steps: [{ click: "Go", timeout: "300ms", expect: { noCalls: ["deleteEverything"] } }],
  }).run();
  assert.equal(result.steps[0].verdict, "fail", JSON.stringify(result.steps[0].checks));

  // The same through the snapshot: not_text reads the live tree.
  const shown = plainApp({ clickMs: 400, late: { go: { after: 300, text: "Error!" } } });
  const second = await runner(shown.session, {
    steps: [{ click: "Go", timeout: "300ms", expect: { notText: ["Error!"] } }],
  }).run();
  assert.equal(second.steps[0].verdict, "fail", JSON.stringify(second.steps[0].checks));
});

test("an explicit settle is watched in full, however short the step's timeout", async () => {
  const caught = plainApp({ late: { go: { after: 900, text: "Error!" } } });
  const long = await runner(caught.session, {
    steps: [{ click: "Go", timeout: "100ms", settle: "2s", expect: { notText: ["Error!"] } }],
  }).run();
  assert.equal(long.steps[0].verdict, "fail", "a 2 s settle sees what arrives at 0.9 s");

  // And a short one is short: the settle is a floor on watching, not a delay.
  const missed = plainApp({ late: { go: { after: 1500, text: "Error!" } } });
  const t0 = Date.now();
  const short = await runner(missed.session, {
    steps: [{ click: "Go", settle: "100ms", expect: { notText: ["Error!"] } }],
  }).run();
  assert.equal(short.steps[0].verdict, "pass");
  assert.ok(Date.now() - t0 < 1_400, `accepted after its settle, not its 30 s timeout (${Date.now() - t0}ms)`);
});

test("settle: none watches for the step's whole timeout, and still ends", async () => {
  const quietApp = plainApp();
  const t0 = Date.now();
  const clean = await runner(quietApp.session, {
    steps: [{ click: "Go", timeout: "600ms", settle: "none", expect: { notText: ["Error!"] } }],
  }).run();
  const took = Date.now() - t0;
  assert.equal(clean.steps[0].verdict, "pass");
  assert.ok(took >= 550 && took < 3_000, `watched for the step's 600 ms, then accepted (${took}ms)`);

  const loud = plainApp({ late: { go: { after: 400, text: "Error!" } } });
  const caught = await runner(loud.session, {
    steps: [{ click: "Go", timeout: "800ms", settle: "none", expect: { notText: ["Error!"] } }],
  }).run();
  assert.equal(caught.steps[0].verdict, "fail");
});

// --- `run` hands every budget on --------------------------------------------------

test("run hands the spec's startup, command and call budgets to boot, and the command line wins startup", async () => {
  const { spec } = specFile([
    "startup_timeout: 5m",
    "command_timeout: 45s",
    "call_timeout: 90s",
    "steps:",
    "  - click: Go",
  ]);
  const seen = {};
  const stop = { boot: async (opts) => {
    seen.opts = opts;
    throw new Error("stop here");
  } };
  await quiet(() => assert.rejects(() => run({ specPath: spec }, stop), /stop here/));
  assert.equal(seen.opts.timeoutMs, 300_000, "startup_timeout reaches boot");
  assert.equal(seen.opts.commandTimeoutMs, 45_000, "command_timeout bounds the probe and the opens outside steps");
  assert.equal(seen.opts.callTimeoutMs, 90_000);

  await quiet(() => assert.rejects(() => run({ specPath: spec, timeoutMs: 1_000, commandTimeoutMs: 7_000, callTimeoutMs: 5_000 }, stop), /stop here/));
  assert.equal(seen.opts.timeoutMs, 1_000, "--timeout wins over startup_timeout: it describes the machine");
  assert.equal(seen.opts.commandTimeoutMs, 7_000, "outside a step, --command-timeout wins");
  assert.equal(seen.opts.callTimeoutMs, 90_000, "the spec that declares the window knows its build");
});

test("run hands --step-timeout, --command-timeout and --call-timeout to its steps", async () => {
  // --step-timeout: a wait that cannot come true gives up on the flag's budget.
  const waits = specFile(["open_settle: 0ms", "steps:", "  - open: demo_ui", "  - wait_for: { text: [Never] }"]);
  const t0 = Date.now();
  const { code, out } = await quiet(() =>
    run({ specPath: waits.spec, noSetup: true, stepTimeoutMs: 300 }, stubBoot(plainApp())),
  );
  assert.equal(code, 1, out);
  assert.ok(Date.now() - t0 < 10_000, `on the flag's 300 ms, not the 30 s default (${Date.now() - t0}ms)`);

  // --command-timeout: every command in the step runs under exactly that.
  const clicks = specFile(["open_settle: 0ms", "steps:", "  - open: demo_ui", "  - click: Go"]);
  const fixed = plainApp();
  await quiet(() => run({ specPath: clicks.spec, noSetup: true, commandTimeoutMs: 4_321 }, stubBoot(fixed)));
  assert.ok(fixed.scopes.length > 0 && fixed.scopes.every((ms) => ms === 4_321), JSON.stringify(fixed.scopes));

  // --call-timeout: the step's defaults are derived from the declared window.
  const window = plainApp();
  await quiet(() => run({ specPath: clicks.spec, noSetup: true, callTimeoutMs: 60_000 }, stubBoot(window)));
  assert.ok(window.scopes.includes(70_000), `the window plus 10 s: ${JSON.stringify(window.scopes)}`);
});

test("run --settle reaches the spec's steps and its setup profile alike", async () => {
  // A click whose forbidden effect arrives 2 s later: the 1 s default settle
  // misses it, which is exactly why someone passes --settle 4s.
  const late = { go: { after: 2_000, text: "Boom" }, gate: { after: 2_000, text: "Boom" } };
  // Each step also has a 3 s timeout, shorter than the 4 s settle: a failing
  // not_text is retried until the deadline, and 30 s of that is not the point.
  const own = specFile([
    "open_settle: 0ms", "steps:", "  - open: demo_ui",
    "  - click: Go", "    timeout: 3s", "    expect: { not_text: [Boom] }",
  ]);
  const unsettled = await quiet(() => run({ specPath: own.spec, noSetup: true }, stubBoot(plainApp({ late }))));
  assert.equal(unsettled.code, 0, "the default settle cannot see it, as documented");
  const settled = await quiet(() => run({ specPath: own.spec, noSetup: true, settleMs: 4_000 }, stubBoot(plainApp({ late }))));
  assert.equal(settled.code, 1, settled.out);

  // The profile's own step, which the review found left on the 1 s default.
  const gated = specFile(
    ["open_settle: 0ms", "steps:", "  - open: demo_ui"],
    ["steps:", "  - name: walk the gate", "    click: Gate", "    timeout: 3s", "    expect: { not_text: [Boom] }"],
  );
  const profiled = await quiet(() =>
    run({ specPath: gated.spec, setup: gated.setup, settleMs: 4_000 }, stubBoot(plainApp({ late }))),
  );
  assert.equal(profiled.code, 1, "the profile watched for the run's 4 s and saw it");
  assert.match(profiled.out, /Boom/);
});

// --- boot hands the command deadline to the inspector ----------------------------

/** A repo holding one built ui_qml plugin. */
function appRepo() {
  const root = scratch("sito-wiring-repo-");
  const dir = path.join(root, "plugins", "demo_ui");
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "import QtQuick\nItem {}\n");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(DEMO));
  return root;
}

/** The tree commands.test.mjs crawls: a shell, a sidebar entry and a dock with two buttons. */
const APP_TREE = {
  id: "root", type: "QQuickWindow", objectName: "", text: "", visible: true, enabled: true,
  children: [
    { id: "settings", type: "Button_QMLTYPE_1", objectName: "settingsButton", text: "Settings", visible: true, enabled: true, children: [] },
    { id: "sidebar-demo_ui", type: "ItemDelegate_QMLTYPE_7", objectName: "", text: "demo_ui", visible: true, enabled: true, children: [] },
    {
      id: "dock", type: "QQuickWidget", objectName: "demo_ui", text: "", visible: true, enabled: true,
      children: [{
        id: "main", type: "Main_QMLTYPE_9", objectName: "", text: "", visible: true, enabled: true,
        children: [
          { id: "refresh", type: "Button_QMLTYPE_2", objectName: "refreshButton", text: "Refresh", visible: true, enabled: true, children: [] },
          { id: "about", type: "Button_QMLTYPE_3", objectName: "aboutButton", text: "About", visible: true, enabled: true, children: [] },
        ],
      }],
    },
  ],
};

/** deps whose boot launches the fake, remembering every boot so a test can look inside it. */
function fakeDeps(root, env = {}) {
  const boots = [];
  return {
    boots,
    boot: async (opts) => {
      const b = await boot({
        ...opts,
        cwd: opts.cwd ?? root,
        basecamp: FAKE,
        timeoutMs: 15_000,
        env: { FAKE_TREE: JSON.stringify(APP_TREE), ...env, ...(opts.env ?? {}) },
      });
      booted.push(b);
      boots.push(b);
      return b;
    },
  };
}

test("boot hands --command-timeout, or the declared window, to the inspector it builds", async () => {
  const root = appRepo();
  const fixed = await fakeDeps(root).boot({ cwd: root, commandTimeoutMs: 7_000 });
  assert.equal(fixed.session.inspector.commandTimeoutMs, 7_000);
  const window = await fakeDeps(root).boot({ cwd: root, callTimeoutMs: 60_000 });
  assert.equal(window.session.inspector.commandTimeoutMs, 70_000, "the declared window plus 10 s");

  // Attached, through the other constructor.
  const sockets = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    s.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const attached = await boot({ attachTo: { port: server.address().port }, commandTimeoutMs: 9_000, timeoutMs: 5_000 });
    try {
      assert.equal(attached.session.inspector.commandTimeoutMs, 9_000);
    } finally {
      await attached.dispose();
    }
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("inspect, init and the crawl follow the bridge window the app logs as it opens", async () => {
  // A Basecamp built with a 120 s window says so on its first synchronous
  // dispatch. The open, the wallet unlock and the listing that follow must be
  // allowed that window, not the stock 20 s one boot knew about.
  const root = appRepo();
  const env = { FAKE_CALL_WINDOW_MS: "120000" };

  const listed = fakeDeps(root, env);
  const shown = await quiet(() => inspect({ cwd: root, noSetup: true, json: true }, listed));
  assert.equal(shown.code, 0, shown.out);
  assert.equal(listed.boots[0].session.inspector.commandTimeoutMs, 130_000, "inspect read the window after opening");

  const written = fakeDeps(root, env);
  const out = path.join(scratch("sito-wiring-init-"), "spec.yaml");
  const wrote = await quiet(() => init({ cwd: root, noSetup: true, out }, written));
  assert.equal(wrote.code, 0, wrote.out);
  assert.equal(written.boots[0].session.inspector.commandTimeoutMs, 130_000, "and so did init");

  const crawled = fakeDeps(root, env);
  await quiet(() => smoke({ cwd: root, noSetup: true, noReport: true, limit: 1, settleMs: 60 }, crawled));
  assert.equal(crawled.boots[0].session.inspector.commandTimeoutMs, 130_000, "and so did the crawl");

  // --command-timeout is the deadline outright, whatever the log says.
  const pinned = fakeDeps(root, env);
  await quiet(() => inspect({ cwd: root, noSetup: true, json: true, commandTimeoutMs: 4_000 }, pinned));
  assert.equal(pinned.boots[0].session.inspector.commandTimeoutMs, 4_000);
});

test("the deadline outside a step reads the log, and leaves a chosen one alone", () => {
  const session = { inspector: { commandTimeoutMs: 0 }, logs: new LogBuffer() };
  const following = new OutsideDeadline(session, {});
  assert.equal(following.follow(), 30_000, "nothing logged yet: the stock window plus 10 s");
  assert.equal(session.inspector.commandTimeoutMs, 30_000);
  session.logs.append(DISPATCH(60_000), "stdout");
  assert.equal(following.follow(), 70_000);
  assert.equal(session.inspector.commandTimeoutMs, 70_000);

  const declared = new OutsideDeadline(session, { callTimeoutMs: 90_000 });
  assert.equal(declared.follow(), 100_000, "--call-timeout wins over the log");

  // A call to a module still starting carries Basecamp's own 1.5 s budget on
  // the same line. Learning that must not cut the deadline under boot's.
  const starting = { inspector: { commandTimeoutMs: 30_000 }, logs: new LogBuffer() };
  starting.logs.append(DISPATCH(1_500, "getWalletState"), "stdout");
  assert.equal(new OutsideDeadline(starting, {}).follow(), 30_000);
  assert.equal(new OutsideDeadline(starting, { callTimeoutMs: 5_000 }).follow(), 15_000, "a declared window is taken as it is");

  session.inspector.commandTimeoutMs = 5_000;
  const chosen = new OutsideDeadline(session, { commandTimeoutMs: 5_000 });
  session.logs.append(DISPATCH(600_000), "stdout");
  assert.equal(chosen.follow(), 5_000);
  assert.equal(session.inspector.commandTimeoutMs, 5_000, "--command-timeout is never moved");
});

test("a spec's wallet unlock gets the window its app logged while opening", async () => {
  const provider = { module: "medusa_core", name: "Medusa", needsPassword: true, storePath: "", hasStore: false };
  const unlock = { provider, password: "pw" };
  const opening = (logs) => logs.append(DISPATCH(120_000, "initAccount"), "stdout");

  const learned = plainApp({ onOpen: opening });
  const result = await runner(learned.session, { openSettle: "0ms", steps: [{ open: "demo_ui" }] }, { walletUnlock: unlock }).run();
  assert.equal(result.steps[0].verdict, "pass", result.steps[0].error);
  assert.ok(learned.scopes.includes(130_000), `the unlock ran on the logged window: ${JSON.stringify(learned.scopes)}`);

  const chosen = plainApp({ onOpen: opening });
  await runner(chosen.session, { openSettle: "0ms", commandTimeout: "5s", steps: [{ open: "demo_ui" }] }, { walletUnlock: unlock }).run();
  assert.ok(!chosen.scopes.includes(130_000), `a chosen command_timeout is kept: ${JSON.stringify(chosen.scopes)}`);
});

// --- startup ---------------------------------------------------------------------

test("a build that never prints the core line is ready when its shell is, on any budget", { timeout: 30_000 }, async (t) => {
  // The soft wait for "Logos Core started successfully" used to own the whole
  // budget: a 4 s budget failed at 4 s with the shell drawn at 1.5 s, and with
  // no deadline it waited forever.
  for (const timeoutMs of [8_000, Infinity]) {
    const userDir = scratch("sito-wiring-nocore-");
    const session = await launch({ binary: FAKE, userDir, env: { FAKE_NO_CORE_LINE: "1" } });
    t.after(() => session.stop());
    const t0 = Date.now();
    const ready = await session.waitUntilReady({ timeoutMs });
    assert.ok(Date.now() - t0 < 7_000, `ready as soon as the shell was (${Date.now() - t0}ms, budget ${timeoutMs})`);
    assert.equal(ready.coreStartedMs, null);
    assert.equal(typeof ready.uiProbeMs, "number");
    await session.stop();
  }

  // A build that does print it still has it recorded.
  const userDir = scratch("sito-wiring-core-");
  const session = await launch({ binary: FAKE, userDir });
  t.after(() => session.stop());
  const ready = await session.waitUntilReady({ timeoutMs: 15_000 });
  assert.equal(typeof ready.coreStartedMs, "number");
  await session.stop();
});

test("a Basecamp that exits after opening its port fails startup instead of being probed forever", { timeout: 30_000 }, async (t) => {
  const userDir = scratch("sito-wiring-exit-");
  const tree = { id: "root", type: "QQuickWindow", visible: true, enabled: true, children: [] };
  const session = await launch({
    binary: FAKE,
    userDir,
    env: { FAKE_TREE: JSON.stringify(tree), FAKE_EXIT_AFTER_MS: "1500" },
  });
  t.after(() => session.stop());
  await assert.rejects(() => session.waitUntilReady({ timeoutMs: Infinity }), /exited during startup/);
});

// --- doctor --deep, the init template and the messages ---------------------------

test("doctor --deep hands its startup budgets to boot", async () => {
  const root = appRepo();
  const seen = {};
  const stop = { boot: async (opts) => {
    seen.opts = opts;
    throw new Error("stop here");
  } };
  await quiet(() => main([
    "doctor", "--deep", "--basecamp", FAKE, "--app-dir", root,
    "--timeout", "5m", "--command-timeout", "40s", "--call-timeout", "90s",
  ], stop));
  assert.ok(seen.opts, "doctor --deep booted");
  assert.equal(seen.opts.timeoutMs, 300_000, "a Basecamp slower than 120 s can pass doctor now");
  assert.equal(seen.opts.commandTimeoutMs, 40_000);
  assert.equal(seen.opts.callTimeoutMs, 90_000);
});

test("init writes no fixed timeout, so its steps follow the bridge window", () => {
  const text = template("demo_ui", "demo_ui", [], ["Go"], ["Hello"], false);
  assert.doesNotMatch(text, /^timeout:/m, "a number written here would pin a raised window to 30 s");
  const spec = validateSpec(YAML.parse(text));
  assert.equal(spec.timeout, undefined);
  const session = { inspector: {}, logs: new LogBuffer() };
  session.logs.append(DISPATCH(120_000), "stdout");
  const r = new Runner({ session, spec, appName: "demo_ui", logsUsable: false, onNote: () => {} });
  assert.equal(r.budgetFor(spec.steps[1]).timeoutMs, 130_000);
});

test("a refused duration is named as it was written, never as null", () => {
  const refuse = (yaml) => {
    try {
      validateSpec(YAML.parse(yaml));
    } catch (e) {
      return e.message;
    }
    assert.fail(`accepted: ${yaml}`);
  };
  for (const yaml of ["steps:\n  - sleep: .inf\n", "steps:\n  - sleep: 1e400\n"]) {
    const why = refuse(yaml);
    assert.match(why, /`sleep` has to end, so it cannot be infinity/);
    assert.doesNotMatch(why, /null/);
  }
  const nan = refuse("steps:\n  - click: Go\n    timeout: .nan\n");
  assert.match(nan, /cannot parse timeout NaN/);
  assert.doesNotMatch(nan, /null/);
  assert.match(refuse("timeout: -.inf\nsteps:\n  - click: Go\n"), /cannot be negative/);
});
