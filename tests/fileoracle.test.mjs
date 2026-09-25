// The filesystem oracle: proving a UI action produced a FILE.
//
// Everything here is about the one thing this check must never do — report a
// green because it could not look. An absent file is the answer the spec asked
// for and is a FAIL; a path that cannot be read, or one outside the directories
// this run gave the app, is INCONCLUSIVE with the remedy. Real temp
// directories, no Basecamp.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runChecks, resolveFilePath, toFileExpect } from "../dist/runner/assert.js";
import { appHomeFor } from "../dist/session.js";
import { validateSpec, SpecError } from "../dist/spec/schema.js";
import { Runner } from "../dist/runner/runner.js";
import { LogBuffer } from "../dist/logs/buffer.js";

const emptySnapshot = { nodes: [], labels: () => [], clickTargetFor: (n) => ({ target: n, via: "self" }) };

const dirs = [];
function scratch(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
test.after(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** A throwaway $HOME with one file in it, the way an app under test leaves one. */
function homeWith(rel, body) {
  const home = scratch("sito-file-home-");
  const full = path.join(home, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return home;
}

// logsUsable: false on purpose — with no log evidence the default no_errors and
// calls_succeed add no checks, so what comes back is the file check and nothing
// else, and a count assertion means something.
const ctx = (over = {}) => ({
  inspector: null,
  snapshot: emptySnapshot,
  window: [],
  qmlRootId: null,
  appName: "tip_jar",
  logsUsable: false,
  ignoreCalls: [],
  cursor: 0,
  appHome: null,
  userDirRoot: null,
  ...over,
});

test("a file the app left behind PASSES, and one it did not FAILS with what is there instead", async () => {
  const home = homeWith(".local/share/tip_jar/tips.json", '{"total":"0.42"}');

  const found = await runChecks(ctx({ appHome: home }), { file: ".local/share/tip_jar/tips.json" });
  assert.equal(found.length, 1, "the file check, and nothing invented around it");
  assert.equal(found[0].kind, "file");
  assert.equal(found[0].verdict, "pass");

  // The point of the whole key: a file the spec asked for and that is not there
  // is the app failing, not the tool being unable to look.
  const missing = await runChecks(ctx({ appHome: home }), { file: ".local/share/tip_jar/receipt.json" });
  assert.equal(missing[0].verdict, "fail");
  assert.match(missing[0].detail, /does not exist/);
  assert.match(missing[0].detail, /"tips\.json"/, "and says what the directory holds, the way nearestLabels does");

  // A directory is not a file. `file:` claims a file, so passing on the strength
  // of something else being at the path would claim more than it proved.
  const dir = await runChecks(ctx({ appHome: home }), { file: ".local/share/tip_jar" });
  assert.equal(dir[0].verdict, "fail");
  assert.match(dir[0].detail, /is a directory/);
});

test("contains reads the file, and one without the substring is a FAIL not a pass", async () => {
  const home = homeWith("exports/tips.csv", "when,amount\n2026-09-05,0.42\n");

  const hit = await runChecks(ctx({ appHome: home }), { file: { path: "exports/tips.csv", contains: "0.42" } });
  assert.equal(hit[0].verdict, "pass");
  assert.match(hit[0].description, /contains "0\.42"/, "the report names what was required, not just the path");

  // The file exists, so an implementation that only stat'ed it reports a green
  // here — a check that proved nothing about the contents it claimed to check.
  const miss = await runChecks(ctx({ appHome: home }), { file: { path: "exports/tips.csv", contains: "1.00" } });
  assert.equal(miss[0].verdict, "fail");
  assert.match(miss[0].detail, /exists \(\d+ bytes\) but does not contain it/);

  // The string form and the object form are the same expectation, the way a
  // bare label and a selector are.
  assert.deepEqual(toFileExpect("exports/tips.csv"), { path: "exports/tips.csv" });
  assert.deepEqual(toFileExpect({ path: "a", contains: "b" }), { path: "a", contains: "b" });
});

test("a path that cannot be read is INCONCLUSIVE, never a fail", async () => {
  // Evidence that cannot be read is not evidence of absence. Grading an
  // unreadable path FAIL would blame the app for the tool's own blindness, and
  // that is precisely what INCONCLUSIVE exists for.
  const home = homeWith("keep/me.txt", "hi");

  // Deterministic on both platforms in the CI matrix: NAME_MAX is 255, so this
  // errno is neither ENOENT nor ENOTDIR and the file cannot be looked at at all.
  const tooLong = await runChecks(ctx({ appHome: home }), { file: "x".repeat(300) });
  assert.equal(tooLong[0].verdict, "inconclusive");
  assert.match(tooLong[0].detail, /ENAMETOOLONG/);
  assert.match(tooLong[0].detail, /not evidence that it is absent/);

  // `contains` reads the whole file, and an app that appends to a log has no
  // upper bound — the runner running out of memory would take the report with
  // it. Sparse, so this costs no disk and no time.
  const big = path.join(home, "big.log");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 9 * 1024 * 1024);
  const oversized = await runChecks(ctx({ appHome: home }), { file: { path: "big.log", contains: "x" } });
  assert.equal(oversized[0].verdict, "inconclusive");
  assert.match(oversized[0].detail, /reads the file into memory/);

  // The permission case itself. Guarded rather than skipped: root ignores the
  // mode bits, and a test that quietly passes for the wrong reason is worse
  // than no test. The ENAMETOOLONG block above enters the same catch arm
  // unconditionally, so this file still holds the rule on any machine.
  if (process.getuid !== undefined && process.getuid() !== 0) {
    const locked = path.join(home, "locked");
    fs.mkdirSync(path.join(locked, "sub"), { recursive: true });
    fs.writeFileSync(path.join(locked, "sub", "out.json"), "{}");
    fs.chmodSync(locked, 0o000);
    try {
      const denied = await runChecks(ctx({ appHome: home }), { file: "locked/sub/out.json" });
      assert.equal(denied[0].verdict, "inconclusive", "EACCES is not absence");
      assert.match(denied[0].detail, /EACCES/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  }
});

test("a path outside the directories this run owns is INCONCLUSIVE, and the user-dir is one of them", async () => {
  const home = scratch("sito-file-home-");
  const userDir = scratch("sito-file-udir-");
  fs.mkdirSync(path.join(userDir, "module_data", "tip_jar"), { recursive: true });
  fs.writeFileSync(path.join(userDir, "module_data", "tip_jar", "state.json"), "{}");

  assert.deepEqual(resolveFilePath("a/b", home, null), { path: path.join(home, "a", "b") });
  assert.deepEqual(resolveFilePath(path.join(home, "a"), home, null), { path: path.join(home, "a") });
  // Basecamp keeps module_data under the user-dir, not under $HOME, so an app
  // that persists through the host writes outside the sandbox home entirely.
  assert.deepEqual(
    resolveFilePath(path.join(userDir, "module_data/tip_jar/state.json"), home, userDir),
    { path: path.join(userDir, "module_data", "tip_jar", "state.json") },
  );
  for (const escape of ["/etc/passwd", "../../etc/passwd"]) {
    const out = resolveFilePath(escape, home, userDir);
    assert.ok(out.why, `${escape} must not resolve to somewhere this run does not own`);
    assert.match(out.why, /outside this run's \$HOME/);
  }

  // Through the assertion engine, and this is the one that matters: /etc/passwd
  // EXISTS on both platforms in the CI matrix, so a check that merely stat'ed it
  // would report a green about a file the app under test never touched.
  const escaped = await runChecks(ctx({ appHome: home, userDirRoot: userDir }), { file: "/etc/passwd" });
  assert.equal(escaped[0].verdict, "inconclusive", "and it is not a pass");
  assert.match(escaped[0].detail, /relative to \$HOME/, "with the remedy, not just a refusal");

  const inUserDir = await runChecks(
    ctx({ appHome: home, userDirRoot: userDir }),
    { file: path.join(userDir, "module_data/tip_jar/state.json") },
  );
  assert.equal(inUserDir[0].verdict, "pass");
});

test("attach mode has no $HOME to resolve against, and does not borrow sitometres' own", async () => {
  // sandboxHome is null in two different situations and they are not the same
  // question: --real-home means the app really did see the developer's $HOME,
  // while attach means sitometres chose nothing at all. Resolving a spec's path
  // against our own HOME there would answer about a directory the app never saw.
  assert.equal(appHomeFor("/tmp/sitometres-home-x", "owned"), "/tmp/sitometres-home-x");
  assert.equal(appHomeFor("/tmp/sitometres-home-x", "attached"), null, "attach never invents one");

  const realHome = process.env.HOME;
  try {
    process.env.HOME = "/home/pretend";
    assert.equal(appHomeFor(null, "owned"), "/home/pretend", "--real-home: this is the one the app got");
    assert.equal(appHomeFor(null, "attached"), null);
    delete process.env.HOME;
    assert.equal(appHomeFor(null, "owned"), os.homedir());
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }

  const checks = await runChecks(ctx({ appHome: null }), { file: ".local/share/tip_jar/tips.json" });
  assert.equal(checks[0].verdict, "inconclusive", "not a pass and not a failure");
  assert.match(checks[0].detail, /attach mode/);
});

/** Enough of a session for the Runner to drive with no Basecamp anywhere. */
function fakeSession() {
  return {
    logs: new LogBuffer(),
    inspector: {
      getTree: async () => ({ tree: { id: "root", type: "Item", children: [] } }),
      evaluate: async () => ({ result: true, undefined: false }),
      screenshot: async () => ({ image: "" }),
      clickRef: async () => ({}),
    },
  };
}

test("a file that appears after the gesture is waited for, and the step returns as soon as it does", async () => {
  // A click is POSTED, not sent: when the gesture returns, nothing has written
  // anything yet. `file:` is monotone — waiting can only make it true — so it
  // has to be re-checked on every poll, must NOT be abandoned on the first
  // absent look (that is `settled`), and must NOT be held for the settle floor
  // once it holds (that is `allMonotone`). All three at once, by the clock.
  const home = scratch("sito-file-home-");
  const session = fakeSession();
  const runner = new Runner({
    session,
    spec: { app: "a", timeout: "8s", steps: [{ name: "the export lands", expect: { file: "exports/tips.csv" } }] },
    appName: "a",
    logsUsable: false,
    appHome: home,
    // Far longer than the file takes to appear: a check misfiled as negative
    // would sit here for the whole five seconds before accepting a clean result.
    settleMs: 5_000,
  });
  setTimeout(() => {
    fs.mkdirSync(path.join(home, "exports"), { recursive: true });
    fs.writeFileSync(path.join(home, "exports", "tips.csv"), "when,amount\n");
  }, 300);

  const t0 = Date.now();
  const result = await runner.run();
  const elapsed = Date.now() - t0;

  assert.equal(result.verdict, "pass", "treating it as irrecoverable would report FAIL at about 250ms");
  assert.equal(result.steps[0].checks[0].kind, "file");
  assert.ok(elapsed < 3_000, `a monotone check must not wait out the settle floor (took ${elapsed}ms)`);
  assert.ok(elapsed >= 250, `and it cannot have passed before the file existed (took ${elapsed}ms)`);
});

test("wait_for on a file reports the check it waited on", async () => {
  // Dropping a wait_for's checks meant a wait on unreadable evidence returned
  // PASS in 38ms with an empty list. The file oracle inherits that fix, and this
  // pins it, because "the export appeared" is the natural thing to wait on
  // before asserting what is inside it.
  const home = scratch("sito-file-home-");
  const session = fakeSession();
  const runner = new Runner({
    session,
    spec: {
      app: "a",
      timeout: "5s",
      steps: [{ name: "wait for the export", waitFor: { file: "exports/tips.csv" } }],
    },
    appName: "a",
    logsUsable: false,
    appHome: home,
    settleMs: 50,
  });
  setTimeout(() => {
    fs.mkdirSync(path.join(home, "exports"), { recursive: true });
    fs.writeFileSync(path.join(home, "exports", "tips.csv"), "when,amount\n");
  }, 200);

  const result = await runner.run();
  const step = result.steps[0];
  assert.equal(step.verdict, "pass");
  assert.equal(step.checks.length, 1, "it used to report PASS with checks: []");
  assert.equal(step.checks[0].kind, "file");
});

test("the spec format takes the three shapes text: takes, and rejects a mistyped one", () => {
  // The object form is where a typo hides: `file: [{ pth: "x" }]` would reach
  // the runner as an expectation with no path at all, and an expectation that
  // constrains nothing is the silently-passing check caseFix exists to prevent.
  const ok = (expect) => validateSpec({ app: "a", steps: [{ click: "Go", expect }] }).steps[0].expect;
  assert.equal(ok({ file: "exports/tips.csv" }).file, "exports/tips.csv");
  assert.deepEqual(ok({ file: { path: "a", contains: "b" } }).file, { path: "a", contains: "b" });
  assert.deepEqual(ok({ file: ["a", { path: "b" }] }).file, ["a", { path: "b" }]);

  const bad = (expect) =>
    assert.throws(
      () => validateSpec({ app: "a", steps: [{ click: "Go", expect }] }),
      (e) => e instanceof SpecError,
      `this should not have validated: ${JSON.stringify(expect)}`,
    );
  bad({ file: [{ pth: "x" }] });
  bad({ file: [{ contains: "x" }] });
  bad({ file: { path: "a", contains: 3 } });
  bad({ file: "" });
  bad({ file: 3 });
  // A key whose entries are all commented out parses as null. `calls:` and
  // `events:` reject that rather than silently asserting nothing, and this
  // agrees with them.
  bad({ file: null });
});

test("an --env HOME overlay is the $HOME the app got, and what `file:` resolves against", () => {
  // boot merges opts.env OVER the sandbox's own and launch applies that over
  // process.env, so `--env HOME=...` really does win. Deriving appHome from the
  // sandbox root alone made every `file:` check stat a directory the app never
  // wrote to and report FAIL — the app blamed for the runner's bookkeeping.
  assert.equal(
    appHomeFor("/tmp/sandbox-home", "owned", { HOME: "/tmp/fixture-home" }),
    "/tmp/fixture-home",
    "the overlay wins, because the child process saw it win",
  );
  assert.equal(
    appHomeFor("/tmp/sandbox-home", "owned", {}),
    "/tmp/sandbox-home",
    "with no overlay the sandbox root is still the answer",
  );
  assert.equal(
    appHomeFor("/tmp/sandbox-home", "attached", { HOME: "/tmp/fixture-home" }),
    null,
    "attach chose nothing, whatever the overlay says",
  );
});

test("`contains: \"\"` is refused, because no file can fail it", () => {
  // Every file contains the empty string, an empty one included, so the check
  // could only ever pass. A green that cannot go red is the thing this whole
  // validator exists to refuse.
  assert.throws(
    () => validateSpec({ app: "x", steps: [{ click: "Go", expect: { file: { path: "a", contains: "" } } }] }),
    (e) => e instanceof SpecError && /cannot fail/.test(e.message),
  );
  // The path alone stays legal - that is the check the author meant.
  const ok = validateSpec({ app: "x", steps: [{ click: "Go", expect: { file: { path: "a" } } }] });
  assert.equal(ok.steps[0].expect.file.path, "a");
});
