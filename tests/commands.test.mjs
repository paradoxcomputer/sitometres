// The five verbs, end to end, with no Basecamp.
//
// Every command begins `await boot(opts)`, and until that became an injectable
// dependency nothing in the suite could call one. So the crawl's exit code, its
// five artifact-emitting exits, its crash attribution, `run`'s stillborn report
// and the CLI's own dispatch were all reachable only by launching a real Qt
// binary — which is how a green suite shipped a CI gate that exited 0 on an app
// whose backend call had failed, twice, and why the late-failure sweep ended up
// "verified" by a regex over its own source text.
//
// Two seams make this file possible, and neither is a test-only hack:
//   * `CommandDeps` — a caller may supply the boot. CONTRIBUTING prescribes
//     exactly this ("if you cannot test something without launching an app,
//     that is usually a sign the logic wants extracting").
//   * tests/helpers/fake-basecamp.mjs — a real process on the other end of a
//     real socket, so the parts that ARE the process still get exercised.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boot } from "../dist/session.js";
import { smoke } from "../dist/commands/smoke.js";
import { run } from "../dist/commands/run.js";
import { inspect } from "../dist/commands/inspect.js";
import { init } from "../dist/commands/init.js";
import { doctor } from "../dist/commands/doctor.js";
import { main, cliMain } from "../dist/cli.js";
import zlib from "node:zlib";
import { displayArtifact } from "../dist/app/fingerprint.js";
import { hostVariant } from "../dist/app/userdir.js";
import { stagingNotes } from "../dist/session.js";
import { formatStagedLines } from "../dist/report/terminal.js";

const FAKE = fileURLToPath(new URL("./helpers/fake-basecamp.mjs", import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const cleanups = [];
const sessions = [];
test.after(async () => {
  for (const b of sessions.splice(0)) {
    try {
      await b.dispose();
    } catch {
      /* already gone */
    }
  }
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

function scratch(prefix) {
  const dir = tmp(prefix);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A repo holding one built ui_qml plugin. */
function appRepo(name = "demo_ui") {
  const root = scratch("sito-cmd-repo-");
  const dir = path.join(root, "plugins", name);
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "import QtQuick\nItem {}\n");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name, type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} }),
  );
  return root;
}

/**
 * A tree the crawl can actually crawl: a dock named for the app, holding
 * controls of the kinds collectClickables recognises.
 */
const appTree = (extra = []) => ({
  id: "root",
  type: "QQuickWindow",
  objectName: "",
  text: "",
  visible: true,
  enabled: true,
  children: [
    { id: "settings", type: "Button_QMLTYPE_1", objectName: "settingsButton", text: "Settings", visible: true, enabled: true, children: [] },
    // The sidebar delegate openApp clicks to open the app.
    { id: "sidebar-demo_ui", type: "ItemDelegate_QMLTYPE_7", objectName: "", text: "demo_ui", visible: true, enabled: true, children: [] },
    {
      id: "dock",
      type: "QQuickWidget",
      objectName: "demo_ui",
      text: "",
      visible: true,
      enabled: true,
      children: [
        {
          id: "main",
          type: "Main_QMLTYPE_9",
          objectName: "",
          text: "",
          visible: true,
          enabled: true,
          children: [
            { id: "refresh", type: "Button_QMLTYPE_2", objectName: "refreshButton", text: "Refresh", visible: true, enabled: true, children: [] },
            { id: "about", type: "Button_QMLTYPE_3", objectName: "aboutButton", text: "About", visible: true, enabled: true, children: [] },
            ...extra,
          ],
        },
      ],
    },
  ],
});

/** deps whose boot launches the fake, with the tree and knobs a test wants. */
function fakeDeps(root, env = {}) {
  return {
    boot: async (opts) => {
      const b = await boot({
        ...opts,
        cwd: opts.cwd ?? root,
        basecamp: FAKE,
        timeoutMs: 15_000,
        env: { FAKE_TREE: JSON.stringify(appTree()), ...env, ...(opts.env ?? {}) },
      });
      sessions.push(b);
      return b;
    },
  };
}

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

// --- smoke -------------------------------------------------------------------

test("the headline command crawls an app and writes the artifacts it was asked for", async () => {
  const root = appRepo();
  const outDir = scratch("sito-artifacts-");
  const junit = path.join(outDir, "results.xml");
  const json = path.join(outDir, "report.json");

  const { code, out } = await quiet(() =>
    smoke({ cwd: root, junit, json, noReport: true, limit: 4, settleMs: 60, noSetup: true }, fakeDeps(root)),
  );

  assert.equal(code, 0, out);
  assert.ok(fs.existsSync(junit), "a CI job that asked for --junit must get a file, always");
  assert.ok(fs.existsSync(json));
  const xml = fs.readFileSync(junit, "utf8");
  assert.match(xml, /<testsuite name="sitometres\.demo_ui"/);
  assert.match(xml, /failures="0"/);
  // The clicks really happened: the fake logs a dispatch per click, and the
  // crawl grades them from that.
  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.equal(report.verdict, "pass");
  // Which build was crawled, in the artifacts and not only in the header the
  // terminal ate. `app` is a name and `basecamp` is a path; neither of them
  // says which copy of demo_ui was staged.
  assert.equal(report.source.origin, path.join("plugins", "demo_ui"));
  assert.equal(report.source.form, "dir");
  assert.match(xml, /<property name="sitometres.origin" value="plugins\/demo_ui"\/>/);
  assert.ok(
    report.steps.some((s) => /click "Refresh"/.test(s.name)),
    `expected a Refresh click among ${report.steps.map((s) => s.name).join(", ")}`,
  );
});

test("a crawl of an app that opens on nothing clickable is inconclusive, and --strict fails it", async () => {
  // Four ways to reach the end having clicked nothing, and all of them used to
  // produce a passing report with one passing testcase: a green CI job that
  // tested nothing at all.
  const root = appRepo();
  const bare = {
    id: "root", type: "QQuickWindow", objectName: "", text: "", visible: true, enabled: true,
    children: [
      { id: "settings", type: "Button_QMLTYPE_1", objectName: "s", text: "Settings", visible: true, enabled: true, children: [] },
      { id: "sidebar-demo_ui", type: "ItemDelegate_QMLTYPE_7", objectName: "", text: "demo_ui", visible: true, enabled: true, children: [] },
      { id: "dock", type: "QQuickWidget", objectName: "demo_ui", text: "", visible: true, enabled: true,
        children: [{ id: "main", type: "Main_QMLTYPE_9", objectName: "", text: "", visible: true, enabled: true, children: [] }] },
    ],
  };
  const outDir = scratch("sito-bare-");
  const junit = path.join(outDir, "results.xml");

  const deps = fakeDeps(root, { FAKE_TREE: JSON.stringify(bare) });
  const loose = await quiet(() => smoke({ cwd: root, junit, noReport: true, noSetup: true }, deps));
  assert.equal(loose.code, 0, "without a gate, an inconclusive crawl still exits 0");
  assert.match(fs.readFileSync(junit, "utf8"), /<skipped/, "but the artifact says it proved nothing");
  // This exit writes its own report rather than the crawl's, and it still has
  // to say what was under test — a crawl that clicked nothing was still
  // pointed at a build.
  assert.match(fs.readFileSync(junit, "utf8"), /<property name="sitometres.origin"/);

  const strict = await quiet(() => smoke({ cwd: root, junit, noReport: true, noSetup: true, strict: true }, deps));
  assert.equal(strict.code, 1, "--strict is what turns that into a failing build");
});

test("a click that kills the app still leaves a report naming the control", async () => {
  // A click that kills Basecamp makes the NEXT snapshot throw on a dead socket,
  // and that throw used to escape past the report entirely: no table, no --json,
  // no --junit. Everything learned before the app died is still worth having,
  // and CI needs to be told which control killed it rather than "no test results".
  const root = appRepo();
  const outDir = scratch("sito-crash-");
  const json = path.join(outDir, "report.json");

  const { code } = await quiet(() =>
    smoke(
      { cwd: root, json, noReport: true, limit: 4, settleMs: 60, noSetup: true },
      // 2, not 1: openApp spends the first click on the sidebar entry, so
      // killing on that one tests a failed open rather than a crashed crawl.
      fakeDeps(root, { FAKE_CLICK_KILLS: "2" }),
    ),
  );

  assert.equal(code, 1, "the app died; that is a failure");
  assert.ok(fs.existsSync(json), "and the artifact was still written");
  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.equal(report.verdict, "fail", "the exit code and the artifact must agree");

  const crashStep = report.steps.find((s) => /ran to completion/.test(s.name));
  assert.ok(crashStep, `expected a crash step among ${report.steps.map((s) => s.name).join(", ")}`);

  // The control that killed it is named, and no other control is blamed. Here
  // the socket died inside the click call itself, so it is the gesture that is
  // recorded as failed — see the next test for the other path.
  const blamed = report.steps.filter((s) => s.verdict === "fail" && /^click /.test(s.name)).map((s) => s.name);
  assert.deepEqual(blamed, ['click "Refresh"'], "exactly the control in flight, and only it");
});

test("a crash that surfaces after the click names the control in flight, not the one before", async () => {
  // The other half, and the one round four had to fix: a crashing click never
  // reaches results.push, so reading `results` named its PREDECESSOR and let the
  // real culprit disappear from every output. `windows` is appended before
  // grading, so its tail is the click that was actually in progress.
  const root = appRepo();
  const outDir = scratch("sito-crash2-");
  const json = path.join(outDir, "report.json");

  const { code } = await quiet(() =>
    smoke(
      { cwd: root, json, noReport: true, limit: 4, settleMs: 60, noSetup: true },
      fakeDeps(root, { FAKE_CLICK_KILLS: "2", FAKE_DIE_AFTER_CLICK_MS: "40" }),
    ),
  );

  assert.equal(code, 1);
  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  const crashStep = report.steps.find((s) => /ran to completion/.test(s.name));
  assert.ok(crashStep, `expected a crash step among ${report.steps.map((s) => s.name).join(", ")}`);
  assert.match(
    JSON.stringify(crashStep),
    /while clicking .*Refresh/,
    "the first control clicked is the one that killed it; About must not be blamed",
  );
  assert.doesNotMatch(JSON.stringify(crashStep), /About/);
});

test("smoke refuses attach mode, because it has nothing to stage", async () => {
  const root = appRepo();
  const deps = {
    boot: async (opts) => {
      const b = await boot({ ...opts, cwd: root, basecamp: FAKE, timeoutMs: 15_000 });
      sessions.push(b);
      // Attach mode has no discovered app; model that rather than faking a boot.
      return { ...b, app: null };
    },
  };
  const { code, out } = await quiet(() => smoke({ cwd: root, noReport: true, noSetup: true }, deps));
  assert.equal(code, 1);
  assert.match(out, /attach mode cannot stage one/);
});

// --- run ---------------------------------------------------------------------

test("run executes a spec and reports each step", async () => {
  const root = appRepo();
  const specDir = scratch("sito-spec-");
  const spec = path.join(specDir, "demo.yaml");
  fs.writeFileSync(
    spec,
    [
      "app: demo_ui",
      "timeout: 8s",
      "steps:",
      "  - name: the app opens",
      "    open: demo_ui",
      "  - name: refresh asks the backend",
      '    click: "Refresh"',
      "    expect:",
      '      calls: ["demo_core.doThing"]',
      "",
    ].join("\n"),
  );
  const json = path.join(specDir, "report.json");

  const { code, out } = await quiet(() =>
    run({ specPath: spec, cwd: root, json, noSetup: true }, fakeDeps(root)),
  );

  assert.equal(code, 0, out);
  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.deepEqual(report.steps.map((s) => s.name), ["the app opens", "refresh asks the backend"]);
  assert.equal(report.verdict, "pass");
  // The call assertion really was checked against the log, not waved through:
  // the fake emits the dispatch line when a click arrives.
  const step = report.steps[1];
  assert.ok(step.checks.some((c) => c.kind === "calls" && c.verdict === "pass"), JSON.stringify(step.checks));
});

test("the run's artifact says which build the verdict is about", async () => {
  // `app` is a name and `basecamp` is a path, so neither says which copy of the
  // app was graded — and a repo routinely holds two, an unpacked plugins/<name>/
  // beside a freshly built result/*.lgx. run() has always known: it prints
  // "built  plugins/demo_ui (v9.9.9, dir, 0s ago)" in the header and then threw
  // it away before writing --json, so the file CI keeps could not answer the
  // first question anyone asks of a red build.
  const root = appRepo();
  const manifestFile = path.join(root, "plugins", "demo_ui", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "9.9.9" }));

  const specDir = scratch("sito-source-");
  const spec = path.join(specDir, "demo.yaml");
  fs.writeFileSync(
    spec,
    ["app: demo_ui", "timeout: 8s", "steps:", "  - name: the app opens", "    open: demo_ui", ""].join("\n"),
  );
  const json = path.join(specDir, "report.json");

  const { code, out } = await quiet(() =>
    run({ specPath: spec, cwd: root, json, noSetup: true }, fakeDeps(root)),
  );
  assert.equal(code, 0, out);

  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  const origin = path.join("plugins", "demo_ui");
  assert.equal(report.source.origin, origin, "the directory that was staged, relative to where you ran");
  assert.equal(report.source.form, "dir");
  assert.equal(report.source.version, "9.9.9", "the APP's version; report.version is the tool's");
  assert.notEqual(report.source.version, report.version);
  assert.ok(report.source.builtAt > 0, `the staged tree's mtime, not ${report.source.builtAt}`);
  // And it is the build the header named, on its `staged` line. Computing it
  // once is what makes that true; two descriptions of the same thing are two
  // things to keep in step.
  const stagedLine = out.split("\n").find((l) => /^ {2}staged {4}demo_ui 9\.9\.9 /.test(l));
  assert.ok(stagedLine, out);
  assert.ok(stagedLine.includes(`${origin} (dir, `), stagedLine);
  assert.equal(report.staged[0].name, "demo_ui");
  assert.equal(report.staged[0].version, "9.9.9");
  assert.ok(stagedLine.includes(report.staged[0].hashes[0].sha256.slice(0, 16)), "the header prints the same digest the JSON carries");
});

test("an out-of-process run shows which root an expression reached", async () => {
  // FAKE_EVAL_ECHO_OBJECT makes the fake answer with the object it was asked
  // to evaluate in, so a run through a real socket can prove `eval:` went to
  // the app's own root (the dock's Main_QMLTYPE, id "main") and not to the
  // global scope or some other app's.
  const root = appRepo();
  const specDir = scratch("sito-echo-");
  const spec = path.join(specDir, "echo.yaml");
  fs.writeFileSync(
    spec,
    ["app: demo_ui", "timeout: 8s", "steps:", "  - open: demo_ui", '  - eval: "root.answer"', ""].join("\n"),
  );
  const json = path.join(specDir, "report.json");
  const { code, out } = await quiet(() =>
    run({ specPath: spec, cwd: root, json, noSetup: true }, fakeDeps(root, { FAKE_EVAL_ECHO_OBJECT: "1" })),
  );
  assert.equal(code, 0, out);
  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.match(report.steps[1].action, /-> "evaluated:main:root\.answer"$/);
  assert.equal(report.steps[1].app, "demo_ui");
});

test("a set: step assigns a property through the real socket", async () => {
  const root = appRepo();
  const specDir = scratch("sito-set-");
  const spec = path.join(specDir, "set.yaml");
  fs.writeFileSync(
    spec,
    [
      "app: demo_ui",
      "timeout: 8s",
      "steps:",
      "  - open: demo_ui",
      "  - set:",
      "      target: { objectName: refreshButton }",
      "      property: text",
      '      value: "Refreshed!"',
      "",
    ].join("\n"),
  );
  const json = path.join(specDir, "report.json");
  const { code, out } = await quiet(() => run({ specPath: spec, cwd: root, json, noSetup: true }, fakeDeps(root)));
  assert.equal(code, 0, out);
  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.match(report.steps[1].action, /^set Button_QMLTYPE_2\.text = "Refreshed!"$/);
});

test("a spec that cannot be parsed still writes the artifacts CI asked for", async () => {
  // The "no test results" hole: a bad spec path, a missing Basecamp or a failed
  // staging exited 1 having written neither --junit nor --json, which every
  // publisher reports as indistinguishable from never having run.
  const dir = scratch("sito-badspec-");
  const spec = path.join(dir, "broken.yaml");
  fs.writeFileSync(spec, "steps:\n  - clik: \"Save\"\n");
  const junit = path.join(dir, "results.xml");

  await assert.rejects(() => quiet(() => run({ specPath: spec, junit }, fakeDeps(dir))));
  assert.ok(fs.existsSync(junit), "the artifact exists even though the run never started");
  assert.match(fs.readFileSync(junit, "utf8"), /failures="1"/);
});

test("a spec with no steps is refused before anything is launched", async () => {
  // `steps: []` validated cleanly and verdictOf([]) is a pass, so `run` staged
  // the app, launched Basecamp, drove nothing and exited 0 green with a JUnit
  // file reading tests="0". REJECTING is the assertion that this is now settled
  // at validation: nothing is launched to learn it.
  const dir = scratch("sito-emptyspec-");
  const spec = path.join(dir, "empty.yaml");
  fs.writeFileSync(spec, "app: demo_ui\nsteps: []\n");
  const junit = path.join(dir, "results.xml");

  await assert.rejects(
    () => quiet(() => run({ specPath: spec, junit }, REJECTING)),
    /`steps` is empty/,
  );
  assert.ok(fs.existsSync(junit), "and CI is still told why, rather than getting no artifact at all");
  assert.match(fs.readFileSync(junit, "utf8"), /failures="1"/);
});

// --- inspect and init --------------------------------------------------------

test("inspect --json puts a parseable document on stdout and nothing else", async () => {
  const root = appRepo();
  const chunks = [];
  const realLog = console.log;
  const realErr = process.stderr.write.bind(process.stderr);
  console.log = (...a) => chunks.push(a.join(" "));
  process.stderr.write = () => true;
  let code;
  try {
    code = await inspect({ cwd: root, json: true, noSetup: true }, fakeDeps(root));
  } finally {
    console.log = realLog;
    process.stderr.write = realErr;
  }
  assert.equal(code, 0);
  // One document, and it parses. Progress lines used to share this stream, so
  // `sitometres inspect <app> --json | jq` failed with no flag to suppress them.
  const parsed = JSON.parse(chunks.join("\n"));
  assert.equal(parsed.app, "demo_ui");
  assert.ok(parsed.clickables.some((c) => c.label === "Refresh"), JSON.stringify(parsed.clickables));
});

test("inspect lists Basecamp's own dialog controls separately, addressed with in: shell", async () => {
  // shellDialogControls asks the WHOLE tree for an "overlayDialogs" node
  // (0.3.0's dialog overlay, outside every app's dock) and reports the
  // handles inside it that match Basecamp's own naming — confirmationDialog,
  // uninstallDialog, intentChooser and friends — leaving out anything else
  // that happens to live in the same overlay.
  const tree = appTree();
  tree.children.push({
    id: "overlay",
    type: "QQuickItem",
    objectName: "overlayDialogs",
    text: "",
    visible: true,
    enabled: true,
    children: [
      {
        id: "confirm-accept",
        type: "Button_QMLTYPE_44",
        objectName: "confirmationDialog.acceptButton",
        text: "OK",
        visible: true,
        enabled: true,
        children: [],
      },
      // Not a shell dialog handle — SHELL_HANDLE must leave it out.
      { id: "not-a-dialog", type: "Item_QMLTYPE_2", objectName: "somethingElse", text: "", visible: true, enabled: true, children: [] },
    ],
  });

  const chunks = [];
  const realLog = console.log;
  const realErr = process.stderr.write.bind(process.stderr);
  console.log = (...a) => chunks.push(a.join(" "));
  process.stderr.write = () => true;
  const root = appRepo();
  let code;
  try {
    code = await inspect({ cwd: root, json: true, noSetup: true }, fakeDeps(root, { FAKE_TREE: JSON.stringify(tree) }));
  } finally {
    console.log = realLog;
    process.stderr.write = realErr;
  }
  assert.equal(code, 0);
  const parsed = JSON.parse(chunks.join("\n"));
  assert.deepEqual(parsed.shell, [
    { objectName: "confirmationDialog.acceptButton", type: "Button", visible: true, selector: '{ objectName: "confirmationDialog.acceptButton", in: shell }' },
  ]);
});

test("inspect prints pasteable selectors for a human", async () => {
  const root = appRepo();
  const { code, out } = await quiet(() => inspect({ cwd: root, noSetup: true }, fakeDeps(root)));
  assert.equal(code, 0);
  assert.match(out, /Clickable/);
  assert.match(out, /objectName=refreshButton/, "the stable handle is what a spec should use");
});

test("init writes a spec built from the app's real controls, and refuses to clobber", async () => {
  const root = appRepo();
  const dir = scratch("sito-init-");
  const out = path.join(dir, "sitometres.yaml");

  const first = await quiet(() => init({ cwd: root, out, noSetup: true }, fakeDeps(root)));
  assert.equal(first.code, 0, first.out);
  const yaml = fs.readFileSync(out, "utf8");
  assert.match(yaml, /app: "demo_ui"/);
  assert.match(yaml, /click: "Refresh"/, "generated from the live snapshot, not a template");

  const second = await quiet(() => init({ cwd: root, out, noSetup: true }, fakeDeps(root)));
  assert.equal(second.code, 1, "an existing spec is not overwritten without --force");
  assert.match(second.out, /already exists/);

  const forced = await quiet(() => init({ cwd: root, out, force: true, noSetup: true }, fakeDeps(root)));
  assert.equal(forced.code, 0);
});

// --- doctor ------------------------------------------------------------------

test("doctor reports what it found, and fails when the machine cannot run tests", async () => {
  const { code, out } = await quiet(() => doctor({ cwd: scratch("sito-empty-"), basecamp: FAKE }));
  // No app in an empty directory, so it has something to complain about — the
  // point is that it renders a verdict rather than throwing.
  assert.equal(typeof code, "number");
  assert.match(out, /Basecamp|app|inspector/i);
});

test("doctor names a dependency that is neither in the repo nor installed", async () => {
  // The dependency block reads the Basecamp user-dirs to decide whether a
  // declared dependency is already installed. Nothing reached it: `appRepo`
  // declares no dependencies, so on a machine with no Logos install the whole
  // branch was dead. It only ran for a developer who happened to have apps in
  // their own $HOME, which is not a test.
  const root = scratch("sito-doctor-deps-");
  const dir = path.join(root, "plugins", "needs_core");
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "import QtQuick\nItem {}\n");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      name: "needs_core",
      type: "ui_qml",
      view: "qml/Main.qml",
      dependencies: ["absent_core"],
      main: {},
    }),
  );

  // An empty HOME so the answer cannot depend on what this machine has
  // installed: nothing is installed, so the dependency is missing, always.
  const home = scratch("sito-doctor-home-");
  const realHome = process.env.HOME;
  const realUserDir = process.env.LOGOS_USER_DIR;
  process.env.HOME = home;
  delete process.env.LOGOS_USER_DIR;
  try {
    const { out } = await quiet(() => doctor({ cwd: root, basecamp: FAKE }));
    assert.match(out, /needs_core depends on "absent_core"/, out.slice(0, 600));
    assert.match(out, /--with absent_core/, "and it says how to supply it");

    // And the other half: a dependency that IS installed in a Basecamp
    // user-dir is not reported missing. This is the case the comment in
    // doctor.ts is about — the list used to be a third copy that knew neither
    // the macOS locations nor $LOGOS_USER_DIR, so doctor called a dependency
    // missing that the crawl would have found. Nothing exercised it, because
    // reading an installed app needs a user-dir that exists.
    const userDir = scratch("sito-doctor-userdir-");
    const dep = path.join(userDir, "plugins", "absent_core");
    fs.mkdirSync(path.join(dep, "qml"), { recursive: true });
    fs.writeFileSync(path.join(dep, "qml", "Main.qml"), "import QtQuick\nItem {}\n");
    fs.writeFileSync(
      path.join(dep, "manifest.json"),
      JSON.stringify({ name: "absent_core", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} }),
    );
    process.env.LOGOS_USER_DIR = userDir;
    const found = await quiet(() => doctor({ cwd: root, basecamp: FAKE }));
    assert.doesNotMatch(
      found.out,
      /depends on "absent_core"/,
      "an installed dependency must not be reported missing",
    );
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserDir !== undefined) process.env.LOGOS_USER_DIR = realUserDir;
  }
});

test("doctor --deep launches the binary to measure what its logs will show", async () => {
  const root = appRepo();
  const { code, out } = await quiet(() => doctor({ cwd: root, basecamp: FAKE, deep: true }, fakeDeps(root)));
  assert.equal(typeof code, "number");
  assert.match(out, /log|evidence|verbose|quiet/i, out.slice(0, 400));
});

// --- doctor predicts what a run stages ---------------------------------------

/** A tar.gz, the way a .lgx is one. */
function lgxBytes(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(Buffer.byteLength(content).toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
    body.write(content);
    blocks.push(header, body);
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/**
 * The world ST1 was found in: a repo whose `result/` holds a nix build of the
 * dependency, epoch-dated, and a Basecamp install holding the same version,
 * touched now. $HOME and $LOGOS_USER_DIR point at fixtures for as long as `fn`
 * runs, so the answer is about this code and not about this machine.
 */
async function nixWorld(fn) {
  const parent = scratch("sito-doctor-st1-");
  const repo = path.join(parent, "repo");
  const home = path.join(parent, "home");
  const install = path.join(parent, "install");
  const variant = hostVariant();
  for (const d of [home, install]) fs.mkdirSync(d, { recursive: true });
  const ui = path.join(repo, "plugins", "demo_ui");
  fs.mkdirSync(path.join(ui, "qml"), { recursive: true });
  fs.writeFileSync(path.join(ui, "qml", "Main.qml"), "import QtQuick\nItem {}\n");
  fs.writeFileSync(
    path.join(ui, "manifest.json"),
    JSON.stringify({ name: "demo_ui", version: "1.0.0", type: "ui_qml", view: "qml/Main.qml", dependencies: ["demo_core"], main: {} }),
  );
  const store = path.join(parent, "store", "abc-demo_core");
  fs.mkdirSync(store, { recursive: true });
  const coreManifest = { name: "demo_core", version: "0.5.0", type: "core", dependencies: [], main: { [variant]: "demo_core_plugin.so" } };
  const pkg = path.join(store, "demo_core.lgx");
  fs.writeFileSync(pkg, lgxBytes([
    ["manifest.json", JSON.stringify(coreManifest)],
    [`variants/${variant}/demo_core_plugin.so`, "FRESH NIX BUILD"],
  ]));
  fs.utimesSync(pkg, 1, 1);
  fs.symlinkSync(store, path.join(repo, "result"));
  // Two hours old, the build and the link that dates it alike, so an age read
  // by doctor and a moment later by the run header is the same age.
  const then = (Date.now() - 2 * 3_600_000) / 1000;
  fs.lutimesSync(path.join(repo, "result"), then, then);
  for (const f of ["manifest.json", "qml/Main.qml"]) fs.utimesSync(path.join(ui, f), then, then);
  const installed = path.join(install, "modules", "demo_core");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, "demo_core_plugin.so"), "THE OLD INSTALL");
  fs.writeFileSync(path.join(installed, "manifest.json"), JSON.stringify(coreManifest));

  const prev = { HOME: process.env.HOME, LOGOS_USER_DIR: process.env.LOGOS_USER_DIR };
  process.env.HOME = home;
  process.env.LOGOS_USER_DIR = install;
  try {
    return await fn({ repo, install, pkg: path.join(repo, "result", "demo_core.lgx") });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The lines doctor printed under "would stage for <app>:", without their indent. */
function wouldStage(out, app) {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.includes(`would stage for ${app}:`));
  assert.notEqual(at, -1, out);
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("    ")) break;
    body.push(l.slice(4));
  }
  return body;
}

test("doctor predicts the staged artifacts: the same paths and digests a run's header prints (ST2)", async () => {
  await nixWorld(async ({ repo, pkg }) => {
    const { out } = await quiet(() => doctor({ cwd: repo, basecamp: FAKE }));
    const predicted = wouldStage(out, "demo_ui");

    const b = await boot({ cwd: repo, basecamp: FAKE, timeoutMs: 15_000 });
    sessions.push(b);
    try {
      const core = b.stagedRecords.find((r) => r.name === "demo_core");
      assert.equal(core.artifact, pkg, "the run staged the nix build, not the install");
      assert.equal(core.provenance, "local");
      const header = formatStagedLines(b.stagedRecords, stagingNotes(b.plan), false);
      assert.deepEqual(predicted, header, "doctor prints exactly the lines the header prints");
      for (const r of b.stagedRecords) {
        const line = predicted.find((l) => l.startsWith(`${r.name} `));
        assert.ok(line.includes(displayArtifact(r.artifact)), line);
        assert.ok(line.includes(r.hashes[0].sha256.slice(0, 16)), `${r.name}: ${line}`);
      }
      // The store says 1970; the out-link says when `nix build` wrote it.
      assert.match(predicted.find((l) => l.startsWith("demo_core ")), /\(lgx, 2h ago\)/);
    } finally {
      await b.dispose();
    }
  });
});

test("doctor never dates a build to 1970 (ST1)", async () => {
  await nixWorld(async ({ repo }) => {
    // A package in dist/ with an epoch mtime and no out-link to date it.
    const variant = hostVariant();
    const pkg = path.join(repo, "dist", "epoch_ui.lgx");
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.writeFileSync(pkg, lgxBytes([
      ["manifest.json", JSON.stringify({ name: "epoch_ui", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} })],
      [`variants/${variant}/qml/Main.qml`, "Item {}"],
    ]));
    fs.utimesSync(pkg, 1, 1);
    const { out } = await quiet(() => doctor({ cwd: repo, basecamp: FAKE }));
    const found = out.split("\n").find((l) => l.includes("plugins/epoch_ui"));
    assert.ok(found, out);
    assert.match(found, /build time unknown/);
    assert.doesNotMatch(out, /\d{5,} min ago|days ago/, "no age counted from the epoch, anywhere");
  });
});

test("doctor prints a plan for each UI app when none is named", async () => {
  await nixWorld(async ({ repo }) => {
    const other = path.join(repo, "plugins", "other_ui");
    fs.mkdirSync(path.join(other, "qml"), { recursive: true });
    fs.writeFileSync(path.join(other, "qml", "Main.qml"), "Item {}");
    fs.writeFileSync(path.join(other, "manifest.json"), JSON.stringify({ name: "other_ui", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} }));
    const { out } = await quiet(() => doctor({ cwd: repo, basecamp: FAKE }));
    assert.equal(wouldStage(out, "demo_ui").length, 2, "the app and its dependency");
    assert.equal(wouldStage(out, "other_ui").length, 1);
    const { out: one } = await quiet(() => doctor({ cwd: repo, basecamp: FAKE, app: "other_ui" }));
    assert.doesNotMatch(one, /would stage for demo_ui/, "--app narrows it to one");
  });
});

test("doctor --deep fails when the run staged something other than it predicted (ST2)", async () => {
  await nixWorld(async ({ repo }) => {
    const bootWith = (tamper) => ({
      boot: async (opts) => {
        const b = await boot({ ...opts, basecamp: FAKE, timeoutMs: 15_000 });
        sessions.push(b);
        return { ...b, stagedRecords: tamper(b.stagedRecords) };
      },
    });
    const honest = await quiet(() => doctor({ cwd: repo, basecamp: FAKE, deep: true }, bootWith((r) => r)));
    assert.equal(honest.code, 0, honest.out);
    assert.match(honest.out, /the run staged exactly what was predicted \(2 artifact\(s\)/);

    const swapped = await quiet(() =>
      doctor({ cwd: repo, basecamp: FAKE, deep: true }, bootWith((records) =>
        records.map((r) => (r.name === "demo_core"
          ? { ...r, hashes: r.hashes.map((h) => ({ ...h, sha256: "f".repeat(64) })) }
          : r)))),
    );
    assert.equal(swapped.code, 1, "a mismatch is a problem");
    assert.match(swapped.out, /demo_core: the run staged something other than doctor predicted/);
    assert.match(swapped.out, /predicted .*demo_core\.lgx library [0-9a-f]{16}/);
    assert.match(swapped.out, /staged {4}.*demo_core\.lgx library ffffffffffffffff/);
  });
});

// --- the CLI's own dispatch --------------------------------------------------

test("main routes a bare app name to the crawl", async () => {
  const root = appRepo();
  const outDir = scratch("sito-main-");
  const junit = path.join(outDir, "results.xml");
  const { code } = await quiet(() =>
    main(["demo_ui", "--app-dir", root, "--junit", junit, "--no-report", "--no-setup", "--limit", "2", "--settle", "60"], fakeDeps(root)),
  );
  assert.equal(code, 0);
  assert.ok(fs.existsSync(junit), "the verb with no name is smoke, and it ran");
});

test("main answers --help and --version without booting anything", async () => {
  const exploding = {
    boot: async () => {
      throw new Error("boot must not be reached for --help");
    },
  };
  const help = await quiet(() => main(["--help"], exploding));
  assert.equal(help.code, 0);
  assert.match(help.out, /USAGE/);

  const version = await quiet(() => main(["--version"], exploding));
  assert.equal(version.code, 0);
  assert.match(version.out, /^\d+\.\d+\.\d+$/m);
});

test("main refuses a spec-less run rather than guessing", async () => {
  const { code, out } = await quiet(() => main(["run"], { boot: async () => assert.fail("must not boot") }));
  assert.equal(code, 1);
  assert.match(out, /run needs a spec file/);
});

test("cliMain turns an argument error into two readable lines, not a stack trace", async () => {
  // Every error class this tool raises carries something the developer can act
  // on. Printing a stack trace instead is the one thing the CLI must never do.
  const codes = [];
  const { out } = await quiet(async () => {
    cliMain(["run", "spec.yaml", "--breakpoint", "3"], REJECTING, (c) => codes.push(c));
    // cliMain is fire-and-forget; give its promise chain a turn to settle.
    await new Promise((r) => setTimeout(r, 50));
    return 0;
  });
  assert.deepEqual(codes, [1], "an ArgError exits 1");
  assert.match(out, /--breakpoint needs --debug/);
  assert.match(out, /Pausing happens in debug mode/, "the hint is the actionable half");
  assert.doesNotMatch(out, /at Object\.|\.js:\d+:\d+/, "and no stack trace");
});

test("cliMain reports a clean run as completed", async () => {
  const codes = [];
  await quiet(async () => {
    cliMain(["--version"], REJECTING, (c) => codes.push(c));
    await new Promise((r) => setTimeout(r, 50));
    return 0;
  });
  assert.deepEqual(codes, [0]);
});

const REJECTING = {
  boot: async () => {
    throw new Error("this test must not reach boot");
  },
};

test("inspect emits an addressable selector for a field, hidden or not", async () => {
  // A field with no objectName can only be addressed positionally, and `nth`
  // must index the selector's OWN matches. resolveAll excludes hidden nodes
  // unless asked, so a hidden field is not among its matches and findIndex
  // returned -1 — and `nth: 0` for that addressed the first VISIBLE field
  // instead: a pasteable selector silently pointing at a different control.
  const root = appRepo();
  const withFields = {
    id: "root", type: "QQuickWindow", objectName: "", text: "", visible: true, enabled: true,
    children: [
      { id: "settings", type: "Button_QMLTYPE_1", objectName: "", text: "Settings", visible: true, enabled: true, children: [] },
      { id: "sidebar-demo_ui", type: "ItemDelegate_QMLTYPE_7", objectName: "", text: "demo_ui", visible: true, enabled: true, children: [] },
      {
        id: "dock", type: "QQuickWidget", objectName: "demo_ui", text: "", visible: true, enabled: true,
        children: [{
          id: "main", type: "Main_QMLTYPE_9", objectName: "", text: "", visible: true, enabled: true,
          children: [
            // Named: the stable handle, and the one inspect should recommend.
            { id: "pw", type: "TextField_QMLTYPE_3", objectName: "passwordField", text: "", visible: true, enabled: true, children: [] },
            // Unnamed and visible: addressable only by position.
            { id: "amount", type: "TextField_QMLTYPE_3", objectName: "", text: "", visible: true, enabled: true, children: [] },
            // Unnamed and hidden: needs include_hidden, and an index from the
            // list that actually contains it.
            { id: "memo", type: "TextField_QMLTYPE_3", objectName: "", text: "", visible: false, enabled: true, children: [] },
            // Two controls sharing a label, so a bare text selector is ambiguous
            // and the emitted one has to carry the type as well.
            { id: "a", type: "Button_QMLTYPE_2", objectName: "", text: "Open", visible: true, enabled: true, children: [] },
            { id: "b", type: "Button_QMLTYPE_2", objectName: "", text: "Open", visible: true, enabled: true, children: [] },
          ],
        }],
      },
    ],
  };

  const chunks = [];
  const realLog = console.log;
  const realErr = process.stderr.write.bind(process.stderr);
  console.log = (...a) => chunks.push(a.join(" "));
  process.stderr.write = () => true;
  let code;
  try {
    code = await inspect(
      { cwd: root, json: true, hidden: true, noSetup: true },
      fakeDeps(root, { FAKE_TREE: JSON.stringify(withFields) }),
    );
  } finally {
    console.log = realLog;
    process.stderr.write = realErr;
  }
  assert.equal(code, 0);
  const parsed = JSON.parse(chunks.join("\n"));

  const named = parsed.fields.find((f) => f.objectName === "passwordField");
  assert.equal(named.selector, '{ objectName: "passwordField" }', "a stable handle is always preferred");

  const visible = parsed.fields.find((f) => f.visible && !f.objectName);
  // nth: 1, not 0 — the index counts the SELECTOR's own matches, which include
  // the named field above it. Numbering from this listing's array position
  // instead would emit a selector that resolves to a different control.
  assert.equal(visible.selector, '{ type: "TextField", nth: 1 }', "the type is shortened, and the index is its own");

  const hidden = parsed.fields.find((f) => !f.visible);
  assert.match(hidden.selector, /include_hidden: true/, "a hidden field says how to reach it");
  assert.match(hidden.selector, /nth: \d+/);

  const ambiguous = parsed.clickables.filter((c) => c.label === "Open");
  assert.ok(ambiguous.length >= 1);
  assert.match(
    ambiguous[0].selector,
    /\{ text: "Open", type: "Button" \}/,
    "a label two controls share cannot be pasted on its own",
  );
});
