// Integration tests: these launch a real Basecamp and take ~30s each, so they
// are opt-in rather than part of the default suite.
//
//   SITOMETRES_INTEGRATION=1 node --test tests/integration.test.mjs
//
// They cover behaviour that cannot be unit-tested because it is about process
// lifetime, not logic.
import test from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENABLED = process.env.SITOMETRES_INTEGRATION === "1";

// Bracket the first character so the pattern cannot match the test runner's own
// command line — pkill -f will otherwise happily kill its own parent.
const PAT = "result/bin/[.]LogosBasecamp";
const running = () => {
  try {
    return Number(execSync(`pgrep -fc '${PAT}' || true`).toString().trim()) || 0;
  } catch {
    return 0;
  }
};
const sweep = () => {
  try {
    execSync(`pkill -f '${PAT}' || true`);
  } catch {
    /* nothing to kill */
  }
};

test(
  "Ctrl-C tears down the Basecamp it started",
  { skip: ENABLED ? false : "set SITOMETRES_INTEGRATION=1", timeout: 120_000 },
  async () => {
    // An interrupted run used to leave Basecamp and a logos_host_qt per core
    // module behind, holding a user-dir and an inspector port, with nothing
    // left alive to reap them.
    sweep();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(running(), 0, "a stray instance was already running");

    const cli = spawn("sitometres", ["medusa_ui", "--limit", "1", "--settle", "800"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 14_000));
    assert.equal(running(), 1, "Basecamp should be up by now");

    cli.kill("SIGINT");
    await new Promise((r) => {
      const t = setTimeout(r, 8000);
      cli.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
    await new Promise((r) => setTimeout(r, 3000));

    const left = running();
    sweep();
    assert.equal(left, 0, "SIGINT must not leave Basecamp behind");
  },
);

// --- debug mode ------------------------------------------------------------
//
// Debug mode is about process lifetime and stdin, which is exactly what cannot
// be unit-tested: the defect that made the whole suite hang was createDebugREPL
// holding process.stdin open, and only a real run proves it lets go.

const SPEC = `
app: zonescan_lite
timeout: 30s
steps:
  - name: the app opens
    open: zonescan_lite
`;

/** Throwaway directories sitometres could have created, right now. */
function tmpDirsNow() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((f) => f.startsWith("sitometres-"))
    .sort();
}

/** Run the real CLI, with stdin closed, and return how it ended. */
function runCli(args, { stdin = "ignore", timeout = 180_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-int-"));
  const spec = path.join(dir, "spec.yaml");
  fs.writeFileSync(spec, SPEC);
  const started = Date.now();
  const r = spawnSync("sitometres", ["run", spec, ...args], {
    stdio: [stdin, "pipe", "pipe"],
    timeout,
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, elapsed: Date.now() - started, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test(
  "--debug with no terminal completes instead of blocking forever",
  { skip: ENABLED ? false : "set SITOMETRES_INTEGRATION=1", timeout: 240_000 },
  () => {
    // --breakpoint forces a pause to be ATTEMPTED. Without one, a passing run
    // never reaches a pause point, so it would prove nothing about stdin.
    const r = runCli(["--debug", "--breakpoint", "1"]);
    assert.notEqual(r.signal, "SIGTERM", "the run must not have to be killed");
    assert.equal(r.status, 0, `expected a clean run, got:\n${r.out}`);
    assert.match(r.out, /interactive terminal/, "and it must say why it did not pause");
  },
);

test(
  "a --debug run with a breakpoint still reaps Basecamp and the throwaway dirs",
  { skip: ENABLED ? false : "set SITOMETRES_INTEGRATION=1", timeout: 240_000 },
  async () => {
    sweep();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(running(), 0, "a stray instance was already running");

    // A subprocess never has a TTY, so this exercises the path a CI run takes:
    // a breakpoint is requested, cannot be honoured, and teardown must be
    // exactly as clean as a normal run's. Driving an actual pause needs a
    // pseudo-terminal, which the unit tests cover with a fake TTY stream.
    const before = new Set(tmpDirsNow());
    const r = runCli(["--debug", "--breakpoint", "1"], { stdin: "pipe" });
    await new Promise((res) => setTimeout(res, 3000));

    const left = running();
    sweep();
    assert.equal(left, 0, `quitting must not leave Basecamp behind:\n${r.out}`);
    // Only what THIS run created. Scanning all of /tmp also catches debris from
    // older sessions, which would make the test fail for something it is not
    // testing — and, worse, pass once somebody tidied up by hand.
    const leaked = tmpDirsNow().filter((f) => !before.has(f));
    assert.deepEqual(leaked, [], `throwaway dirs left behind by this run: ${leaked.join(", ")}`);
  },
);

test(
  "time spent paused is not charged against a step's timeout",
  { skip: ENABLED ? false : "set SITOMETRES_INTEGRATION=1", timeout: 240_000 },
  () => {
    // A pause is human time. If it came out of the step budget, stopping to
    // look at anything would fail the step you stopped to look at.
    const r = runCli(["--debug"]);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /timed out/i, `no step may time out because of debug mode:\n${r.out}`);
  },
);
