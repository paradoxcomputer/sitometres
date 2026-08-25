// The debug REPL.
//
// The tests here were rewritten: the originals built object literals and
// asserted those literals' own fields back, so they passed whether or not
// debug.ts existed — and the one that did touch the module hung `node --test`
// forever, because createDebugREPL opened process.stdin at construction and
// nothing ever closed it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDebugREPL } from "../dist/runner/debug.js";

const context = (over = {}) => ({
  active: false,
  stepNumber: 1,
  stepDescription: "test step",
  isBreakpoint: false,
  isFailure: false,
  ...over,
});

/** Records which callbacks the REPL actually reached. */
function spyCallbacks() {
  const seen = [];
  return {
    seen,
    getState: async () => (seen.push("getState"), "{}"),
    getLogs: async () => (seen.push("getLogs"), "no calls"),
    getUI: async () => (seen.push("getUI"), "[]"),
    nextStep: async () => void seen.push("nextStep"),
    continueExecution: () => void seen.push("continueExecution"),
    quit: async () => void seen.push("quit"),
  };
}

test("creating the REPL does not take stdin hostage", () => {
  // The whole suite used to hang here. Building the REPL must be inert; only
  // pausing may touch stdin.
  const before = process.stdin.listenerCount("data") + process.stdin.listenerCount("readable");
  const pause = createDebugREPL(context(), spyCallbacks());
  assert.equal(typeof pause, "function");
  const after = process.stdin.listenerCount("data") + process.stdin.listenerCount("readable");
  assert.equal(after, before, "no stdin listeners may be registered until a pause happens");
});

test("a pause with no terminal continues instead of blocking forever", async () => {
  // Under CI, a pipe, or `node --test`, nobody can answer the prompt. Waiting
  // on that stdin is an unkillable hang.
  const cbs = spyCallbacks();
  const ctx = context();
  const pause = createDebugREPL(ctx, cbs);

  const isTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    const action = await pause();
    assert.equal(action, "continue");
    assert.equal(ctx.active, false, "the context must not be left marked active");
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  }
});

test("commands reach their callbacks and end the pause correctly", async () => {
  // Drive the REPL over a real pipe, in a child process, so the readline path
  // itself is exercised rather than mocked away.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-debug-"));
  const out = path.join(dir, "result.json");
  const script = path.join(dir, "drive.mjs");
  const debugUrl = new URL("../dist/runner/debug.js", import.meta.url).href;

  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
import { PassThrough } from "node:stream";
const { createDebugREPL } = await import(${JSON.stringify(debugUrl)});

// A fake TTY stdin we can write commands into.
const fake = new PassThrough();
fake.isTTY = true;
Object.defineProperty(process, "stdin", { value: fake, configurable: true });

const seen = [];
const cbs = {
  getState: async () => (seen.push("getState"), "{}"),
  getLogs: async () => (seen.push("getLogs"), "no calls"),
  getUI: async () => (seen.push("getUI"), "[]"),
  nextStep: async () => void seen.push("nextStep"),
  continueExecution: () => void seen.push("continueExecution"),
  quit: async () => void seen.push("quit"),
};
const ctx = { active: false, stepNumber: 2, stepDescription: "click Send",
              isBreakpoint: false, isFailure: false };
const pause = createDebugREPL(ctx, cbs);

const p1 = pause();
fake.write("state\\n");        // inspect, stay paused (JSON, pretty-printed)
fake.write("logs\\n");         // and again with output that is NOT JSON
fake.write("n\\n");            // then advance
const a1 = await p1;

const p2 = pause();
fake.write("q\\n");
const a2 = await p2;

fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ seen, a1, a2, active: ctx.active }));
process.exit(0);
`,
  );

  const r = spawnSync(process.execPath, [script], { timeout: 30_000, encoding: "utf8" });
  assert.ok(fs.existsSync(out), `the child never finished: ${r.stderr || r.stdout}`);
  const got = JSON.parse(fs.readFileSync(out, "utf8"));

  assert.deepEqual(
    got.seen,
    ["getState", "getLogs", "nextStep", "quit"],
    "each command must reach its callback once — `logs` is here because its output is not JSON, " +
      "which is the other half of the formatter",
  );
  assert.equal(got.a1, "next");
  assert.equal(got.a2, "quit");
  assert.equal(got.active, false, "context.active must be cleared when a pause ends");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a second pause does not replay the first pause's input", async () => {
  // The interface was built once and a new "line" listener added per pause, so
  // the n-th pause handled every keystroke n times.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-debug2-"));
  const out = path.join(dir, "result.json");
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

const seen = [];
const cbs = {
  getState: async () => (seen.push("getState"), "{}"),
  getLogs: async () => (seen.push("getLogs"), "l"),
  getUI: async () => (seen.push("getUI"), "u"),
  nextStep: async () => void seen.push("nextStep"),
  continueExecution: () => void seen.push("continueExecution"),
  quit: async () => void seen.push("quit"),
};
const ctx = { active: false, stepNumber: 1, stepDescription: "s",
              isBreakpoint: false, isFailure: false };
const pause = createDebugREPL(ctx, cbs);

for (let i = 0; i < 3; i++) {
  const p = pause();
  fake.write("state\\n");
  fake.write("n\\n");
  await p;
}
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ seen }));
process.exit(0);
`,
  );

  const r = spawnSync(process.execPath, [script], { timeout: 30_000, encoding: "utf8" });
  assert.ok(fs.existsSync(out), `the child never finished: ${r.stderr || r.stdout}`);
  const { seen } = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(
    seen.filter((s) => s === "getState").length,
    3,
    `three pauses, three state commands — got ${JSON.stringify(seen)}`,
  );
  assert.equal(seen.filter((s) => s === "nextStep").length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the prompt reflects the step being paused at, not the first one", async () => {
  // getPrompt was evaluated once at construction, so every pause claimed Step 1.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-debug3-"));
  const out = path.join(dir, "out.txt");
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
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (c, ...rest) => { chunks.push(String(c)); return realWrite(c, ...rest); };

const cbs = { getState: async () => "{}", getLogs: async () => "l", getUI: async () => "u",
              nextStep: async () => {}, continueExecution: () => {}, quit: async () => {} };
const ctx = { active: false, stepNumber: 1, stepDescription: "first",
              isBreakpoint: false, isFailure: false };
const pause = createDebugREPL(ctx, cbs);

const p1 = pause(); fake.write("n\\n"); await p1;
ctx.stepNumber = 7; ctx.stepDescription = "seventh";
const p2 = pause(); fake.write("n\\n"); await p2;

fs.writeFileSync(${JSON.stringify(out)}, chunks.join(""));
process.exit(0);
`,
  );

  const r = spawnSync(process.execPath, [script], { timeout: 30_000, encoding: "utf8" });
  assert.ok(fs.existsSync(out), `the child never finished: ${r.stderr || r.stdout}`);
  const printed = fs.readFileSync(out, "utf8");
  assert.match(printed, /Step 1/);
  assert.match(printed, /Step 7/, "the second pause must not still say Step 1");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- WHEN the runner decides to pause ----------------------------------------
//
// The original tests stubbed the callbacks and never drove the Runner, so they
// could not see that --debug had no reachable step-boundary pause at all: the
// gate read session.debug.active, which starts false and is only set inside a
// pause, making it exactly equal to "is a breakpoint".

import { Runner } from "../dist/runner/runner.js";
import { LogBuffer } from "../dist/logs/buffer.js";

/** A session that answers a scripted debug command at each pause. */
function debugSession(answers) {
  const logs = new LogBuffer();
  const pauses = [];
  return {
    pauses,
    session: {
      logs,
      debug: { active: false, stepNumber: 0, stepDescription: "", isBreakpoint: false, isFailure: false },
      inspector: {
        getTree: async () => ({ tree: { id: "root", type: "Item", children: [] } }),
        evaluate: async () => ({ result: true, undefined: false }),
        screenshot: async () => ({ image: "" }),
        clickRef: async () => ({}),
      },
    },
    // Stand in for the REPL: record that a pause happened, answer from the script.
    pause: async () => {
      pauses.push(true);
      return answers.shift() ?? "continue";
    },
  };
}

function runnerWith(d, steps, over = {}) {
  const r = new Runner({
    session: d.session,
    spec: { app: "a", timeout: "1s", steps },
    appName: "a",
    logsUsable: false,
    settleMs: 10,
    ...over,
  });
  r.debugPause = d.pause; // the REPL itself is covered above
  return r;
}

const STEPS = [
  { name: "one", expect: { state: "root.ok" } },
  { name: "two", expect: { state: "root.ok" } },
  { name: "three", expect: { state: "root.ok" } },
];

test("--debug pauses at every step boundary", async () => {
  const d = debugSession(["next", "next", "next"]);
  await runnerWith(d, STEPS).run();
  assert.equal(d.pauses.length, 3, "plain --debug used to pause exactly zero times");
});

test("next means next, not continue", async () => {
  // `next` returning to a gate that could never be true again made it
  // indistinguishable from `continue`.
  const d = debugSession(["next", "next", "next"]);
  await runnerWith(d, STEPS).run();
  assert.equal(d.pauses.length, 3);

  const c = debugSession(["continue"]);
  await runnerWith(c, STEPS).run();
  assert.equal(c.pauses.length, 1, "continue must stop pausing");
});

test("--breakpoint N pauses only at N", async () => {
  const d = debugSession(["next"]);
  d.session.debug.breakpointStep = 2;
  await runnerWith(d, STEPS).run();
  assert.equal(d.pauses.length, 1, "having named a step, the user is not stopped at every other one");
});

test("without --debug nothing pauses", async () => {
  const d = debugSession([]);
  d.session.debug = undefined;
  const r = new Runner({
    session: d.session,
    spec: { app: "a", timeout: "1s", steps: STEPS },
    appName: "a",
    logsUsable: false,
    settleMs: 10,
  });
  await r.run();
  assert.equal(d.pauses.length, 0);
});

test("the state command sends an expression, not an object id", async () => {
  // evaluate(expression, objectId) was called as evaluate(objectId, "this"),
  // so `state` sent the object id AS the expression and could never work.
  const sent = [];
  const d = debugSession([]);
  d.session.inspector.evaluate = async (expression, objectId) => {
    sent.push({ expression, objectId });
    return { result: '{"phase":"idle"}', undefined: false };
  };
  const r = runnerWith(d, STEPS);
  r.qmlRootId = "qml-root-1";

  const out = await r.debugCallbacks().getState();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].objectId, "qml-root-1", "the root goes in the objectId slot");
  assert.match(sent[0].expression, /this/, "and an expression goes in the expression slot");
  assert.match(out, /"phase": "idle"/, "and the app's state is shown, not the transport envelope");
  assert.doesNotMatch(out, /undefined/, "the EvaluateResult wrapper must not be printed");
});

test("the logs command shows the step's window, not an empty one", async () => {
  // getLogs sliced from a cursor taken at the moment of asking. mark() returns
  // a cursor just past the last line, so the window was empty by construction
  // and it always answered "none" — including when paused on a failure caused
  // by the very calls it was hiding.
  const d = debugSession([]);
  const r = runnerWith(d, STEPS);

  d.session.logs.append('LogosAPIClient: invoking remote method "mod" "doThing" args_count: 0', "stdout");
  d.session.logs.append('[LogosObject] RemoteLogosObject::callMethod "doThing" args: 0', "stdout");
  d.session.logs.append("RemoteLogosObject: callRemoteMethod failed or timed out: 1", "stdout");

  const out = await r.debugCallbacks().getLogs();
  assert.match(out, /mod\.doThing/, "the call the step made must be listed");
  assert.doesNotMatch(out, /Calls observed: none/);
  assert.match(out, /Failed or timed out: .*doThing/, "and so must its failure");
});

test("the UI command returns a snapshot", async () => {
  const d = debugSession([]);
  const r = runnerWith(d, STEPS);
  const out = await r.debugCallbacks().getUI();
  assert.doesNotMatch(out, /^Error/, out);
});

// --- which steps actually pause, when the spec names them --------------------

// `comment: "# breakpoint"` is documented in README.md, SKILL.md and the shipped
// example as the way to stop at the one step you care about. It changed nothing
// but the prompt prefix: under plain --debug every step paused anyway, and
// without --breakpoint N nothing consulted the comment at all. No test in the
// suite had ever set a step comment, though two archived tasks recorded that
// coverage as done.
test("a breakpoint comment is recognised, and ordinary prose is not", async () => {
  const { isBreakpointComment } = await import("../dist/runner/runner.js");
  assert.equal(isBreakpointComment("# breakpoint: verify this step"), true);
  assert.equal(isBreakpointComment("breakpoint"), true);
  assert.equal(isBreakpointComment("# Breakpoint here"), true, "case is not a signal");
  assert.equal(isBreakpointComment(undefined), false);
  assert.equal(isBreakpointComment("# explains why this step exists"), false);
  assert.equal(
    isBreakpointComment("# do not set a breakpointish marker"),
    false,
    "a word boundary, so a comment that merely contains the letters is not one",
  );
});

test("marking a step in the spec means only that step pauses", async () => {
  const marked = [
    { name: "one", expect: { state: "root.ok" } },
    { name: "two", comment: "# breakpoint", expect: { state: "root.ok" } },
    { name: "three", expect: { state: "root.ok" } },
  ];
  const d = debugSession(["next"]);
  const r = runnerWith(d, marked);
  const at = [];
  const pause = d.pause;
  r.debugPause = async () => (at.push(d.session.debug.stepNumber), pause());
  await r.run();
  assert.deepEqual(at, [2], "every step used to pause, whatever the comment said");
});

test("with nothing marked, every step boundary still pauses", async () => {
  const d = debugSession(["next", "next", "next"]);
  await runnerWith(d, STEPS).run();
  assert.equal(d.pauses.length, 3, "the comment is a filter; absent one, nothing is filtered");
});

// Quitting called process.exit(1) from inside the callback, which skipped run's
// `finally` — so a user who quit after seeing the failure they were debugging
// got no summary and no --json/--junit for the steps already graded. That is the
// "no test results" outcome failure-reporting exists to prevent, and it left
// both of run()'s `if (action === "quit")` branches as dead code.
test("quitting returns a result, so the artifacts already earned can be written", async () => {
  const d = debugSession(["next", "quit"]);
  const result = await runnerWith(d, STEPS).run();

  assert.equal(result.verdict !== undefined, true, "a quit must RETURN, not exit the process");
  assert.equal(result.steps.length, 3, "the whole spec is accounted for, not only what ran");
  assert.equal(result.steps[0].name, "one");
  assert.deepEqual(
    result.steps.slice(1).map((s) => s.verdict),
    ["inconclusive", "inconclusive"],
    "the steps a quit never reached are inconclusive, not silently absent",
  );
  assert.match(result.steps[1].checks[0].detail, /quit from the debugger/);
});

test("the quit callback is inert now, rather than ending the process", async () => {
  // It called process.exit(1) directly, so nothing downstream could run —
  // including the report writer. `handleCommand` is what turns `q` into the
  // quit action; the callback only has to return.
  const cbs = spyCallbacks();
  await cbs.quit();
  const d = debugSession([]);
  const real = runnerWith(d, STEPS).debugCallbacks();
  await real.quit();
  assert.equal(d.session.debug.active, false, "quitting does not leave the session mid-pause");
});
