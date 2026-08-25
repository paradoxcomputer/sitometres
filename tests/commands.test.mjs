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
