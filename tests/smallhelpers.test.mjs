// The functions no test had ever executed.
//
// None of these is exotic. They are the single uncovered functions left behind
// in modules whose neighbours are well covered, which is exactly how a function
// stays untested for a year: nothing about the file looks neglected.
// `assessFidelity` — the load-bearing one in this tool's honesty story — was
// reached by no test at all until last week, and three audits walked past it.
//
// What is pinned here, in the order the file runs:
//
//   * which KIND of thing a manifest describes, which decides whether the app
//     can be opened at all and whether a wallet can be unlocked in it;
//   * the log buffer's retention cap and its timeout, i.e. what a step's
//     evidence window is allowed to forget and how a wait ends when nothing
//     comes;
//   * whose QML error a QML error is — Basecamp's own shell, or the app under
//     test;
//   * the `mode` line's promise about whether the logs it read can be trusted;
//   * how a step is NAMED before it runs, which is the only name the status
//     line, the JSON and the JUnit ever get for it;
//   * where a click is delivered and where a property assignment lands, which
//     are deliberately not the same node;
//   * the debugger's help, and the difference between its `next` and its
//     `continue`;
//   * and a setup profile that did not complete, which used to print red and
//     exit 0.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isPureQml, isViewModule, readManifestDir } from "../dist/app/manifest.js";
import { detectWalletProvider } from "../dist/app/wallet.js";
import { LogBuffer } from "../dist/logs/buffer.js";
import { isBasecampInternalNoise, parseLine } from "../dist/logs/classify.js";
import { ChildStdoutSource, FileTailSource } from "../dist/logs/source.js";
import { doClick, doSet } from "../dist/runner/actions.js";
import { SelectorError } from "../dist/runner/selector.js";
import { Runner } from "../dist/runner/runner.js";
import { runSetupProfile } from "../dist/runner/setup.js";

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// --- what kind of thing a manifest describes ---------------------------------

/** A built ui_qml manifest, as the packager emits one. */
const ui = (over = {}) => ({ name: "tip_jar", type: "ui_qml", dependencies: [], ...over });

test("an empty main map means pure QML, which is not the same as having no main", () => {
  // The distinction the whole function exists for. A built manifest ALWAYS
  // carries `main`; the packager writes `"main": {}` for a plugin with no C++
  // view module, so "has a main key" and "has a view module" are different
  // questions, and answering the first one is how a pure-QML plugin gets
  // treated as though Basecamp would spawn a ui-host for it.
  assert.equal(isPureQml(ui()), true, "a source manifest has no main at all");
  assert.equal(isPureQml(ui({ main: {} })), true, "an empty variant map is the packager saying: no .so");
  assert.equal(isPureQml(ui({ main: "" })), true);
  assert.equal(isPureQml(ui({ main: { "linux-amd64-dev": "libtip_jar.so" } })), false);
  assert.equal(isPureQml(ui({ main: "libtip_jar.so" })), false);
});

test("a ui_qml plugin is exactly one of the two kinds; anything else is neither", () => {
  for (const main of [undefined, {}, "", { "linux-amd64-dev": "libtip_jar.so" }, "libtip_jar.so"]) {
    const m = main === undefined ? ui() : ui({ main });
    assert.notEqual(
      isPureQml(m),
      isViewModule(m),
      `main ${JSON.stringify(main)} must resolve to one kind or the other, never both and never neither`,
    );
  }
  // A headless backend module has no UI to open, so it is neither kind — and
  // `type` is what decides that, not the absence of a library.
  const core = { name: "medusa_core", type: "core", dependencies: [] };
  assert.equal(isPureQml(core), false, "a core module has no QML to run in-process");
  assert.equal(isViewModule(core), false, "and no view to host out-of-process either");
  const unknown = { name: "mystery", type: "unknown", dependencies: [] };
  assert.equal(isPureQml(unknown), false);
  assert.equal(isViewModule(unknown), false);
});

test("only a pure-QML plugin is offered a wallet, because only it has the bridge", () => {
  // isPureQml's one caller in the tool. Unlocking runs `logos.callModule` in
  // the app's OWN QML, which is injected into in-process plugins only, so
  // offering the same wallet to a view-module plugin promises an unlock that
  // cannot happen.
  const deps = { name: "medusa_ui", dependencies: ["medusa_core"] };
  const pure = { manifest: ui({ ...deps, main: {} }) };
  const hosted = { manifest: ui({ ...deps, main: { "linux-amd64-dev": "libmedusa_ui.so" } }) };

  const provider = detectWalletProvider(pure, []);
  assert.equal(provider.module, "medusa_core");
  assert.equal(provider.needsPassword, true, "medusa's wallet is the one that takes a password");
  assert.equal(
    detectWalletProvider(hosted, []),
    null,
    "same dependency, same wallet, no bridge to unlock it through",
  );
});

test("a manifest's dependency list keeps the strings and drops everything else", () => {
  // These names are joined into paths and resolved as modules to stage
  // (session.ts builds `new Set([name, ...dependencies, ...--with])`), so a
  // number or an object surviving the filter becomes a staging path built out
  // of "42" or "[object Object]".
  const dir = tmp("sito-manifest-");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      name: "tip_jar",
      type: "ui_qml",
      dependencies: ["medusa_core", 42, null, { name: "logos_core" }, ["nested"], "zonescan_core"],
    }),
  );
  const loaded = readManifestDir(dir);
  assert.deepEqual(loaded.manifest.dependencies, ["medusa_core", "zonescan_core"]);
  assert.equal(loaded.manifest.name, "tip_jar");

  const noDeps = tmp("sito-manifest-");
  fs.writeFileSync(path.join(noDeps, "manifest.json"), JSON.stringify({ name: "tip_jar", type: "ui_qml" }));
  assert.deepEqual(readManifestDir(noDeps).manifest.dependencies, [], "an absent list is an empty one");

  const scalar = tmp("sito-manifest-");
  fs.writeFileSync(
    path.join(scalar, "manifest.json"),
    JSON.stringify({ name: "tip_jar", type: "ui_qml", dependencies: "medusa_core" }),
  );
  assert.deepEqual(
    readManifestDir(scalar).manifest.dependencies,
    [],
    "a scalar where a list belongs must not become one dependency per character",
  );
});

// --- what the log buffer keeps, and how a wait ends --------------------------

test("length is what the buffer still holds, and the cap does not rewind the cursor", () => {
  // The cap exists so a chatty app cannot exhaust memory on a long run —
  // medusa_ui's 800 ms poll accounts for over half the lines in a session. But
  // every step brackets its evidence with a CURSOR, so if discarding old lines
  // renumbered the survivors, a step's window would silently move.
  const buf = new LogBuffer(3);
  assert.equal(buf.length, 0);
  for (let i = 0; i < 5; i++) buf.append(`line ${i}`, "stdout");

  assert.equal(buf.length, 3, "only the retained lines are counted");
  assert.equal(buf.mark(), 5, "sequence numbers count what ARRIVED, so a cursor taken earlier still means what it meant");
  assert.deepEqual(
    buf.slice(0).map((l) => l.text),
    ["line 2", "line 3", "line 4"],
    "and it is the OLDEST lines that go",
  );
  assert.deepEqual(buf.slice(3).map((l) => l.text), ["line 3", "line 4"]);
});

test("tail is the last n lines, in arrival order", () => {
  // lastLines() prints `logs.tail(25)` under "Basecamp exited during startup" —
  // that block IS the diagnosis. The first 25 lines of a session are the Qt
  // platform banner and say nothing about why it died.
  const buf = new LogBuffer();
  for (const t of ["one", "two", "three", "four"]) buf.append(t, "stdout");

  assert.deepEqual(buf.tail(2).map((l) => l.text), ["three", "four"], "the END of the session, not the start");
  assert.deepEqual(
    buf.tail(10).map((l) => l.text),
    ["one", "two", "three", "four"],
    "asking for more than there is gives everything there is",
  );
  assert.deepEqual(new LogBuffer().tail(25), [], "and nothing at all is the `(no output captured)` case");
});

test("a wait that nothing satisfies rejects with the cursor it was watching from", async () => {
  const buf = new LogBuffer();
  buf.append("a line from before the step", "stdout");
  const from = buf.mark();
  assert.equal(from, 1);

  const t0 = Date.now();
  await assert.rejects(
    () => buf.waitFor((l) => l.text.includes("never arrives"), { from, timeoutMs: 120 }),
    (err) => {
      assert.equal(err.name, "LogWaitError", "callers switch on this to tell a timeout from a real failure");
      assert.equal(err.from, from, "which window came up empty is the only actionable part");
      assert.equal(err.message, "no matching log line within 120ms");
      return true;
    },
  );
  assert.ok(Date.now() - t0 >= 100, "the timeout has to be a timeout, not an immediate rejection");

  // The other direction, or everything above would still hold with the waiter
  // machinery replaced by a sleep: a wait is woken by the ARRIVING line, so a
  // step finishes as soon as its evidence lands instead of burning its budget.
  const live = new LogBuffer();
  const waiting = live.waitFor((l) => l.text.includes("Core started"), { timeoutMs: 5_000 });
  const t1 = Date.now();
  setTimeout(() => live.append("Logos Core started successfully!", "stdout"), 20);
  const line = await waiting;
  assert.equal(line.text, "Logos Core started successfully!");
  assert.equal(line.seq, 0);
  assert.ok(Date.now() - t1 < 2_000, "it must not have waited out the 5s timeout to notice");
});

// --- whose QML error is it ---------------------------------------------------

/** Parse real log text the way the runner does: through the buffer. */
function parsed(...lines) {
  const buf = new LogBuffer();
  for (const text of lines) buf.append(text, "stdout");
  return buf.slice(0).map(parseLine);
}

test("a QML error raised in Basecamp's own qrc: shell is house noise; the app's is not", () => {
  // Both directions matter and they fail in opposite ways. Counting Basecamp's
  // shell throwing as the app's error is a false failure on a working app;
  // counting the app's own file:// error as house noise hides the exact defect
  // a run exists to find.
  const [theirs, ours] = parsed(
    "qrc:/qt/qml/Logos/Shell/SidebarPanel.qml:44: TypeError: Cannot read property 'launcherApps' of null",
    "file:///home/dev/.local/share/Logos/LogosBasecampDev/plugins/tip_jar/Main.qml:31: TypeError: Cannot read property 'balance' of undefined",
  );

  assert.equal(theirs.signal.kind, "qml_error");
  assert.equal(theirs.signal.file, "qrc:/qt/qml/Logos/Shell/SidebarPanel.qml");
  assert.equal(isBasecampInternalNoise(theirs), true);

  assert.equal(ours.signal.kind, "qml_error");
  assert.equal(isBasecampInternalNoise(ours), false, "this is the app breaking, and it must be reported as such");
});

test("only a hard error counts as house noise — a qrc: warning and an ordinary line do not", () => {
  const [warning, plain, call] = parsed(
    "qrc:/qt/qml/Logos/Shell/Dock.qml:12: QML Layout: Detected anchors on an item that is managed by a layout.",
    "Qt: Session management error: None of the authentication protocols specified are supported",
    'LogosAPIClient: invoking remote method "medusa_core" "getWalletState" args_count: 0',
  );

  assert.equal(warning.signal.kind, "qml_warning", "the engine emits thousands of these with the same shape");
  assert.equal(
    isBasecampInternalNoise(warning),
    false,
    "the test is on the signal KIND as well as the qrc: prefix; a prefix check alone would swallow warnings too",
  );
  assert.equal(plain.signal, undefined);
  assert.equal(isBasecampInternalNoise(plain), false, "a line carrying no signal at all — most of a session is these");
  assert.equal(call.signal.kind, "call_started");
  assert.equal(isBasecampInternalNoise(call), false);
});

// --- what the run header's `mode` line promises ------------------------------

test("the mode line names the directory being tailed and admits that it lags", () => {
  // This string is the only place a reader learns which of the two sources
  // their run used, and `lagging` is what makes the runner downgrade log
  // verdicts to INCONCLUSIVE rather than lie. Measured: the on-disk file was
  // still 0 bytes six seconds into a run because QFile buffers, so a header
  // that called this "live" would be advertising evidence that is not there.
  const dir = tmp("sito-modeline-");
  const tail = new FileTailSource(dir, new LogBuffer(), { intervalMs: 60_000 });
  try {
    assert.equal(tail.describe(), `${dir} (file tail — lags, Basecamp buffers these writes)`);
    assert.equal(tail.kind, "file-tail");
    assert.equal(tail.lagging, true);
  } finally {
    tail.stop();
  }

  const live = new ChildStdoutSource(new LogBuffer(), {});
  try {
    assert.equal(live.describe(), "child stdout (live)");
    assert.equal(live.kind, "child-stdout");
    assert.equal(live.lagging, false);
  } finally {
    live.stop();
  }

  for (const src of [{ d: tail.describe(), lag: true }, { d: live.describe(), lag: false }]) {
    assert.equal(/lag/.test(src.d), src.lag, `the description and the lagging flag must agree: ${src.d}`);
  }
});

// --- how a step is named before it runs --------------------------------------

/** Enough of a session for the Runner, with a dock of real controls in it. */
function fakeSession(tree) {
  return {
    logs: new LogBuffer(),
    inspector: {
      getTree: async () => ({ tree }),
      evaluate: async () => ({ result: true, undefined: false }),
      screenshot: async () => ({ image: "" }),
      clickRef: async () => ({}),
      setProperty: async () => ({}),
    },
  };
}

test("a click step is named after its selector, whatever shape the selector has", async () => {
  // The step's NAME is built from the selector before the action runs, and it
  // is the only name the status line, the terminal summary, the JSON report
  // and the JUnit test case ever get for an unnamed step. A selector shape
  // that fell through would put `click undefined` — or nothing — into CI.
  const session = fakeSession({
    id: "root",
    type: "QQuickWidget",
    children: [
      {
        id: "col",
        type: "Column_QMLTYPE_7",
        children: [
          {
            id: "btn-send",
            type: "Button_QMLTYPE_12",
            children: [{ id: "txt-send", type: "Text_QMLTYPE_3", text: "Send" }],
          },
          { id: "btn-cancel", type: "Button_QMLTYPE_12", objectName: "cancelButton" },
          { id: "chk-terms", type: "CheckBox_QMLTYPE_44" },
        ],
      },
    ],
  });

  const runner = new Runner({
    session,
    spec: {
      app: "tip_jar",
      timeout: "1s",
      steps: [
        { click: "Send" },
        { click: { text: "Send" } },
        { click: { objectName: "cancelButton" } },
        { click: { type: "CheckBox" } },
        // A selector that names nothing still has to produce a step name. It
        // resolves to nothing and the step fails — which is why it goes last,
        // since a step that could not be performed abandons the rest — but the
        // report still has to be able to say which step that was.
        { click: { nth: 1 } },
      ],
    },
    appName: "tip_jar",
    logsUsable: true,
    settleMs: 10,
  });

  const result = await runner.run();
  assert.deepEqual(
    result.steps.map((s) => s.name),
    ['click "Send"', 'click "Send"', 'click "cancelButton"', 'click "CheckBox"', 'click "(selector)"'],
  );
  assert.deepEqual(
    result.steps.slice(0, 4).map((s) => s.verdict),
    ["pass", "pass", "pass", "pass"],
    "the first four selectors really do resolve, so the names are not describing steps that never happened",
  );
  assert.equal(result.steps[4].verdict, "fail");
  assert.match(
    result.steps[4].error,
    /no element matches/,
    "the step is named and then fails, rather than failing before it can be named",
  );
});

// --- where a gesture is delivered --------------------------------------------

/**
 * One dock's worth of controls, and an inspector that records what was
 * delivered where.
 *
 * Shaped by what doClick and doSet actually call — getTree for the snapshot,
 * clickRef for the click, setProperty for the assignment — and nothing else,
 * so reaching for another command fails the test instead of passing quietly.
 * The tree is the two idioms the snapshot module documents: a Button wrapping
 * its label, and controls whose label lives on the node itself.
 */
function fakeDock() {
  const seen = { getTree: [], clickRef: [], setProperty: [] };
  const tree = {
    id: "root",
    type: "QQuickWidget",
    children: [
      {
        id: "col",
        type: "Column_QMLTYPE_7",
        children: [
          {
            id: "btn-send",
            type: "Button_QMLTYPE_12",
            children: [{ id: "txt-send", type: "Text_QMLTYPE_3", text: "Send" }],
          },
          { id: "btn-cancel", type: "Button_QMLTYPE_12", objectName: "cancelButton" },
          { id: "chk-terms", type: "CheckBox_QMLTYPE_44" },
          // Hidden two ways round, because they are excluded by two different
          // guards: a hidden control still carrying a visible label, and a
          // visible control whose label is bound away.
          {
            id: "btn-withdraw",
            type: "Button_QMLTYPE_12",
            visible: false,
            children: [{ id: "txt-withdraw", type: "Text_QMLTYPE_3", text: "Withdraw" }],
          },
          {
            id: "btn-archive",
            type: "Button_QMLTYPE_12",
            children: [{ id: "txt-archive", type: "Text_QMLTYPE_3", text: "Archive", visible: false }],
          },
          {
            id: "btn-deposit",
            type: "Button_QMLTYPE_12",
            enabled: false,
            children: [{ id: "txt-deposit", type: "Text_QMLTYPE_3", text: "Deposit" }],
          },
        ],
      },
    ],
  };
  const inspector = {
    async getTree(opts) {
      seen.getTree.push(opts);
      return { tree };
    },
    async clickRef(id) {
      seen.clickRef.push(id);
      return { clicked: true, x: 0, y: 0, widget: "QQuickWidget" };
    },
    async setProperty(id, property, value) {
      seen.setProperty.push({ id, property, value });
      return {};
    },
  };
  return { seen, inspector, ctx: { inspector, scopeId: null } };
}

test("a click is delivered to the control, not to the label that matched", async () => {
  // `Button { contentItem: Text { text: "Send" } }` is the ordinary Qt Quick
  // Controls shape, and the label is what the developer names. The inspector's
  // own findAndClick takes the first breadth-first substring hit and never
  // climbs, so it delivers to the Text and no handler runs.
  const { ctx, seen } = fakeDock();
  const out = await doClick(ctx, "Send");

  assert.deepEqual(seen.clickRef, ["btn-send"], "the Button, not txt-send");
  assert.equal(out.targetId, "btn-send");
  assert.equal(
    out.detail,
    'clicked Button_QMLTYPE_12 "Send"',
    "the report names the control's type and the label the spec used",
  );
});

test("the click detail falls back from label to objectName to id", async () => {
  // All three arms matter: a Button whose label lives on a nested Text reports
  // text="" itself, and plenty of controls carry neither. `clicked Button ""`
  // in a report identifies nothing.
  const { ctx } = fakeDock();
  assert.equal((await doClick(ctx, { objectName: "cancelButton" })).detail, 'clicked Button_QMLTYPE_12 "cancelButton"');
  assert.equal((await doClick(ctx, { type: "CheckBox" })).detail, 'clicked CheckBox_QMLTYPE_44 "chk-terms"');
});

test("a control the user cannot see or use is not clicked, and the miss says why", async () => {
  // Neither of the inspector's finders checks visibility, so hidden controls
  // were matched and "clicked" — and apps built out of `visible:`-bound blocks
  // have most of their labels present long before the user can see them.
  const { ctx, seen } = fakeDock();

  for (const label of ["Withdraw", "Archive"]) {
    await assert.rejects(
      () => doClick(ctx, label),
      (err) => {
        assert.ok(err instanceof SelectorError, `${label} must be refused, not clicked`);
        assert.match(err.message, /not visible/);
        assert.match(err.message, /needs a preceding step to reveal it/);
        return true;
      },
    );
  }
  await assert.rejects(
    () => doClick(ctx, "Deposit"),
    (err) => {
      assert.match(err.message, /disabled/);
      assert.match(err.message, /the app may still be busy; try wait_for first/);
      return true;
    },
  );
  assert.deepEqual(seen.clickRef, [], "nothing was posted to either of them");
});

test("a click resolves against the app's own dock, not the whole shell", async () => {
  // Basecamp hides docks rather than destroying them, so every other open
  // plugin's labels are still in the global tree. Scoping the snapshot is what
  // keeps "Connect" from resolving into somebody else's app.
  const { ctx, seen, inspector } = fakeDock();
  await doClick(ctx, "Send");
  assert.deepEqual(seen.getTree, [{ depth: 100 }], "unscoped only before an app has been opened");

  await doClick({ inspector, scopeId: "dock-tip_jar" }, "Send");
  assert.deepEqual(seen.getTree[1], { depth: 100, objectId: "dock-tip_jar" });
});

test("set assigns to the node the selector named, not to the control around it", async () => {
  // Deliberately not doClick's rule, in the same file. A click has to land on
  // something that handles clicks, so it climbs to the Button; a property
  // belongs to the object the spec named, and assigning `opacity` to the
  // Button when the author wrote the label's name changes a different thing.
  const { ctx, seen } = fakeDock();
  const out = await doSet(ctx, { target: "Send", property: "opacity", value: 0.5 });

  assert.deepEqual(seen.setProperty, [{ id: "txt-send", property: "opacity", value: 0.5 }]);
  assert.equal(out.targetId, "txt-send");
  assert.equal(out.detail, "set Text_QMLTYPE_3.opacity = 0.5");
});

test("a set value reaches the app as a value and is only stringified for the report", async () => {
  const { ctx, seen } = fakeDock();

  const bool = await doSet(ctx, { target: { objectName: "cancelButton" }, property: "enabled", value: false });
  assert.equal(seen.setProperty[0].value, false, "the app must get the boolean, not the string \"false\"");
  assert.equal(bool.detail, "set Button_QMLTYPE_12.enabled = false");

  const list = await doSet(ctx, { target: { type: "CheckBox" }, property: "model", value: [1, 2] });
  assert.deepEqual(seen.setProperty[1].value, [1, 2]);
  assert.equal(
    list.detail,
    "set CheckBox_QMLTYPE_44.model = [1,2]",
    "template interpolation instead of JSON.stringify prints `1,2` here and `[object Object]` for a map",
  );
});

// --- the debugger's help -----------------------------------------------------

/**
 * Drive the REPL over a real pipe in a child process, capturing what each
 * command printed on its own.
 *
 * A child, because the REPL needs `process.stdin.isTTY` and a readline
 * interface: faking those in-process would test the fake. Output is segmented
 * per command so "help state printed the state entry" cannot be satisfied by
 * the bare listing printed three commands earlier.
 */
function driveHelp() {
  const dir = tmp("sito-help-");
  const out = path.join(dir, "captured.json");
  const script = path.join(dir, "drive.mjs");
  const debugUrl = new URL("../dist/runner/debug.js", import.meta.url).href;

  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
import { PassThrough } from "node:stream";
const { createDebugREPL } = await import(${JSON.stringify(debugUrl)});

const fake = new PassThrough();
fake.isTTY = true;
Object.defineProperty(process, "stdin", { value: fake, configurable: true });

const chunks = [];
process.stdout.write = (c) => { chunks.push(String(c)); return true; };
const take = async () => {
  await new Promise((r) => setTimeout(r, 30));
  const text = chunks.join("");
  chunks.length = 0;
  return text;
};

const cbs = {
  getState: async () => "{}",
  getLogs: async () => "no calls",
  getUI: async () => "[]",
  nextStep: async () => {},
  continueExecution: () => {},
  quit: async () => {},
};
const ctx = { active: false, stepNumber: 3, stepDescription: "click Send",
              isBreakpoint: false, isFailure: false };
const pause = createDebugREPL(ctx, cbs);

const p = pause();
await take();                                    // discard the first prompt
fake.write("help\\n");           const bare = await take();
fake.write("help state\\n");     const named = await take();
fake.write("help nosuchthing\\n"); const unknown = await take();
fake.write("n\\n");
const action = await p;

fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ bare, named, unknown, action }));
process.exit(0);
`,
  );

  const r = spawnSync(process.execPath, [script], { timeout: 30_000, encoding: "utf8" });
  assert.ok(fs.existsSync(out), `the child never finished: ${r.stderr || r.stdout}`);
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

test("bare help lists every command the REPL actually accepts", () => {
  // It is the only listing there is — the prompt is `... > ` and says nothing —
  // so a command absent from here is a command nobody finds. Both spellings of
  // each, because both are what handleCommand switches on.
  const { bare, action } = driveHelp();
  for (const entry of ["h, help", "s, state", "l, logs", "u, ui", "n, next", "c, continue", "q, quit"]) {
    assert.ok(bare.includes(entry), `help must document ${entry} — it printed:\n${bare}`);
  }
  assert.ok(bare.includes("help <command>"), "including how to ask for more about one of them");
  assert.equal(action, "next", "and asking for help does not advance the run: only `n` ended the pause");
});

test("help for one command explains that command, and is not the listing again", () => {
  const { named } = driveHelp();
  assert.ok(named.includes("state:"), `help state must name what it is answering about:\n${named}`);
  assert.ok(
    named.includes("Requires the app to be opened (QML root available)."),
    "and give the detail the listing had no room for — `state` is inconclusive before an open: step",
  );
  assert.ok(!named.includes("Available commands:"), "not the whole menu a second time");
  assert.ok(!named.includes("Continue execution without pausing"), "and not any other command's entry");
});

test("help for a command that does not exist says so instead of printing nothing", () => {
  // A silent return here leaves the user staring at a bare prompt with no way
  // to tell a typo from a command that ran and had nothing to say.
  const { unknown } = driveHelp();
  assert.match(unknown, /Unknown command: nosuchthing/);
  assert.match(unknown, /Type 'help' for available commands/);
});

// --- next versus continue ----------------------------------------------------

test("the continue callback stops later steps from pausing; the next callback does not", async () => {
  // `next` returning to a gate that could never be true again made it
  // indistinguishable from `continue`. These are the two callbacks that carry
  // that difference, and the only difference between them is which one
  // disables the remaining pause points — so drive the run with the pause
  // itself answering "next" both times, and let the callback be the only
  // variable.
  const steps = [{ name: "one" }, { name: "two" }, { name: "three" }];

  for (const [callback, expected] of [["nextStep", 3], ["continueExecution", 1]]) {
    const session = {
      logs: new LogBuffer(),
      debug: { active: false, stepNumber: 0, stepDescription: "", isBreakpoint: false, isFailure: false },
      inspector: {
        getTree: async () => ({ tree: { id: "root", type: "Item", children: [] } }),
        evaluate: async () => ({ result: true, undefined: false }),
        screenshot: async () => ({ image: "" }),
        clickRef: async () => ({}),
      },
    };
    const runner = new Runner({
      session,
      spec: { app: "a", timeout: "1s", steps },
      appName: "a",
      logsUsable: false,
      settleMs: 10,
    });
    const callbacks = runner.debugCallbacks();
    let pauses = 0;
    runner.debugPause = async () => {
      pauses++;
      await callbacks[callback]();
      return "next";
    };

    const result = await runner.run();
    assert.equal(result.steps.length, 3, "every step still runs either way");
    assert.equal(
      pauses,
      expected,
      `${callback} must ${expected === 1 ? "stop" : "not stop"} the run pausing at later step boundaries`,
    );
  }
});

// --- a setup profile that did not complete -----------------------------------

/** Read the narration back: what it says is half of what is under test. */
async function captured(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = real;
  }
}

/** A booted session with the gate already walked, or not. */
function setupHost(fidelity, tree) {
  return {
    session: fakeSession(tree),
    fidelity: { fidelity },
  };
}

const UNLOCKED = {
  id: "root",
  type: "QQuickWidget",
  children: [{ id: "hdr", type: "Text_QMLTYPE_3", text: "Unlocked" }],
};

test("a setup profile whose steps pass reports how many ran and no failure", async () => {
  const host = setupHost("quiet", UNLOCKED);
  const resolved = {
    file: path.join(os.tmpdir(), "gatekeeper", ".sitometres", "gatekeeper_ui.setup.yaml"),
    spec: {
      app: "gatekeeper_ui",
      timeout: "2s",
      steps: [
        { name: "the door is open", expect: { text: ["Unlocked"] } },
        { name: "and stays open", expect: { text: ["Unlocked"] } },
      ],
    },
  };

  const { value: out, lines } = await captured(() => runSetupProfile(host, resolved, "gatekeeper_ui", "crawl"));

  assert.deepEqual(out, { steps: 2, failed: null });
  const narration = lines.join("\n");
  assert.match(narration, /gatekeeper_ui\.setup\.yaml/, "the header has to say which profile ran");
  assert.match(narration, /the door is open/);
  assert.match(narration, /and stays open/);
  assert.ok(!/FAIL/.test(narration), narration);
});

test("a setup profile that did not complete comes back as a failed: string", async () => {
  // It used to print red and exit 0. A profile that stopped working leaves the
  // app on the wrong screen, so everything reported afterwards describes a
  // state nobody asked to test — and the caller has to be able to attach that
  // to the open step rather than merely having seen some red go past.
  const host = setupHost("verbose", UNLOCKED);
  const resolved = {
    file: path.join(os.tmpdir(), "gatekeeper", ".sitometres", "gatekeeper_ui.setup.yaml"),
    spec: {
      app: "gatekeeper_ui",
      timeout: "1s",
      steps: [{ name: "the app got through the gate without throwing", expect: { noErrors: true } }],
    },
  };
  // Inside the step's own window, as a real one would be: the step marks its
  // log cursor when it starts, so a line appended before that is not evidence
  // about this step at all. The path names the plugin, which is how the error
  // is attributed to the app under test rather than to Basecamp.
  const timer = setTimeout(() => {
    host.session.logs.append(
      "file:///home/dev/.local/share/Logos/LogosBasecampDev/plugins/gatekeeper_ui/Unlock.qml:88: TypeError: Cannot read property 'account' of null",
      "stdout",
    );
  }, 60);

  const { value: out, lines } = await captured(() => runSetupProfile(host, resolved, "gatekeeper_ui", "crawl"));
  clearTimeout(timer);

  assert.equal(out.steps, 1);
  assert.equal(
    out.failed,
    "the setup profile did not complete, so the crawl started from the wrong screen",
    "a string, not null — this is what the caller turns into a failing check",
  );
  const narration = lines.join("\n");
  assert.match(narration, /FAIL/);
  assert.match(narration, /no new QML errors in gatekeeper_ui/, "and the narration says which check went red");
});

test("no profile at all is not a failure, and narrates nothing", async () => {
  const host = setupHost("verbose", UNLOCKED);
  const { value, lines } = await captured(() => runSetupProfile(host, null, "gatekeeper_ui", "crawl"));
  assert.deepEqual(value, { steps: 0, failed: null });
  assert.deepEqual(lines, [], "resolveSetupSpec already said why there was none; saying it twice is noise");
});

test("a profile that stops early narrates through the caller's stream, not straight to stdout", async () => {
  // Found by running `sitometres inspect medusa_ui --json` against a real
  // wallet: the runner's "N later step(s) were not attempted" note went to
  // console.log, landed in the middle of the JSON document, and made the payload
  // unparseable. The runner does not know whose stdout it is writing to, so
  // runSetupProfile has to hand it a stream — the same rule the parse-error line
  // beside it already follows.
  const host = setupHost("quiet", UNLOCKED);
  const resolved = {
    file: path.join(os.tmpdir(), "gatekeeper", ".sitometres", "gatekeeper_ui.setup.yaml"),
    spec: {
      app: "gatekeeper_ui",
      timeout: "2s",
      steps: [
        // No artifact directory, so this step cannot be performed at all.
        { name: "photograph the door", screenshot: "door" },
        { name: "never reached", expect: { text: ["Unlocked"] } },
        { name: "nor this", expect: { text: ["Unlocked"] } },
      ],
    },
  };

  // Loud: the note belongs on stdout with the rest of the run's report.
  const loud = await captured(() => runSetupProfile(host, resolved, "gatekeeper_ui", "crawl"));
  assert.equal((await loud.value).failed !== null, true, "a profile that could not finish is a failure");
  assert.match(loud.lines.join("\n"), /2 later step\(s\) were not attempted/);

  // Quiet: stdout is carrying a document, so not one character of it may.
  const errs = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => (errs.push(String(s)), true);
  let quiet;
  try {
    quiet = await captured(() => runSetupProfile(host, resolved, "gatekeeper_ui", "crawl", true));
    await quiet.value;
  } finally {
    process.stderr.write = realErr;
  }
  assert.deepEqual(quiet.lines, [], "nothing reaches stdout under quiet narration");
  assert.match(errs.join("\n"), /2 later step\(s\) were not attempted/, "and it is not simply lost");
});
