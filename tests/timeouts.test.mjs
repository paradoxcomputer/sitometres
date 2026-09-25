// Every time budget a run spends can be set, and none of them has a ceiling.
//
// The defect this file is built around: Medusa's 30-faucet spec gave itself
// `timeout: 60s`, and step 13 still died at 20.0 s with `inspector command
// "evaluate" timed out after 20000ms`. A step's `timeout:` reached `wait_for`
// and the expect polling and nothing else. Every inspector command, the one
// that runs a synchronous `logos.callModule` included, had a fixed 20 s
// deadline that no spec key, step key or flag could reach. And 20 s is exactly
// the Logos bridge's own reply window, so a call the bridge would have
// answered at 20 s was reported as a hung app instead.
//
// What is pinned here: the grammar (and that it has no maximum), where each
// budget comes from and in what order, that the per-command deadline follows
// the step and the bridge window instead of a constant, and the no-timer path
// that stops a very long budget overflowing Node's setTimeout into ~1 ms.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { InspectorClient, sleep } from "../dist/inspector/client.js";
import { InspectorTransportError } from "../dist/inspector/protocol.js";
import { LogBuffer, LogWaitError } from "../dist/logs/buffer.js";
import { CallWindowTracker, learnCallWindow } from "../dist/logs/classify.js";
import { Runner } from "../dist/runner/runner.js";
import { runSetupProfile } from "../dist/runner/setup.js";
import { clickWindowFor } from "../dist/runner/open.js";
import { parseDuration, SpecError, validateSpec } from "../dist/spec/schema.js";
import { ArgError, durationFlag, main } from "../dist/cli.js";
import { outsideCommandTimeout } from "../dist/session.js";
import * as T from "../dist/timeouts.js";

// Captured before any test mocks the clock: the slow-call tests below advance
// virtual time and need a real pause to let socket I/O through between ticks.
const realSetTimeout = globalThis.setTimeout;
const realPause = (ms) => new Promise((r) => realSetTimeout(r, ms));

/** A newline-JSON inspector on 127.0.0.1:0 that hands each request to `onRequest`. */
async function fakeInspector(t, onRequest) {
  const sockets = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onRequest(JSON.parse(line), sock);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(resolve);
  }));
  return server.address().port;
}

const answer = (sock, req, data = {}) => sock.write(JSON.stringify({ ok: true, ...data, id: req.id }) + "\n");

const DISPATCH = (ms, method = "listAccounts") =>
  `LogosAPIConsumer: Calling invokeRemoteMethod: "medusa_core" "${method}" args_count: 1 timeout: ${ms}`;

// --- the grammar -------------------------------------------------------------

test("a duration is ms, s, m or h, or none, and has no maximum", () => {
  assert.equal(parseDuration("500ms", 0), 500);
  assert.equal(parseDuration("1h", 0), 3_600_000);
  assert.equal(parseDuration("0.5h", 0), 1_800_000);
  assert.equal(parseDuration("10000h", 0), 36_000_000_000, "no ceiling on what a spec may ask for");
  assert.equal(parseDuration(0, 5), 0);
  for (const none of ["none", "unlimited", " NONE ", "Unlimited"]) {
    assert.equal(parseDuration(none, 0), Infinity, none);
  }
  assert.equal(parseDuration(Infinity, 0), Infinity, "YAML's .inf means the same as none");
});

test("a negative or unreadable duration is refused, not guessed at", () => {
  assert.throws(() => parseDuration(-1, 0), /cannot be negative, got -1/);
  assert.throws(() => parseDuration("-5s", 0), /cannot be negative, got "-5s"/);
  assert.throws(() => parseDuration(NaN, 0), /cannot parse duration/);
  assert.throws(() => parseDuration("5d", 0), /cannot parse duration "5d"/);
  assert.throws(() => parseDuration("forever", 0), /cannot parse duration/);
});

const STEPS = [{ click: "Go" }];

test("every header budget is accepted in either spelling and read at load", () => {
  const snake = validateSpec({
    command_timeout: "45s",
    call_timeout: "90s",
    open_timeout: "none",
    startup_timeout: "5m",
    settle: "2s",
    open_settle: "0ms",
    steps: STEPS,
  });
  assert.equal(snake.commandTimeout, "45s");
  assert.equal(snake.callTimeout, "90s");
  assert.equal(snake.openTimeout, "none");
  assert.equal(snake.startupTimeout, "5m");
  assert.equal(snake.settle, "2s");
  assert.equal(snake.openSettle, "0ms");
  const camel = validateSpec({ commandTimeout: 45_000, openTimeout: "2m", steps: STEPS });
  assert.equal(camel.commandTimeout, 45_000);
  assert.equal(camel.openTimeout, "2m");
  // A commented-out key means "not set", as for every other header key.
  assert.equal(validateSpec({ command_timeout: null, steps: STEPS }).commandTimeout, undefined);
});

test("a bad header budget fails at validation, naming the key", () => {
  for (const [doc, re] of [
    [{ command_timeout: "soon" }, /cannot parse command_timeout "soon"\. Use milliseconds/],
    [{ call_timeout: -20 }, /`call_timeout` cannot be negative, got -20/],
    [{ startup_timeout: [] }, /`startup_timeout` must be milliseconds.*got a list/],
    [{ open_settle: "none" }, /`open_settle` has to end/],
    [{ timeout: "-1s" }, /`timeout` cannot be negative/],
  ]) {
    assert.throws(
      () => validateSpec({ ...doc, steps: STEPS }),
      (e) => e instanceof SpecError && re.test(e.message),
      JSON.stringify(doc),
    );
  }
  // The refusal lists what a spec may write, not the camelCase aliases.
  assert.throws(
    () => validateSpec({ comand_timeout: "1s", steps: STEPS }),
    (e) => /Known: .*command_timeout/.test(e.message) && !/commandTimeout/.test(e.message),
  );
});

test("a step's budgets are checked at load, where its header's always were", () => {
  // A bad step `timeout:` used to throw out of Runner.run(), after staging and
  // launching Basecamp, and take the whole run down.
  for (const [step, path, re] of [
    [{ click: "Go", timeout: "10 seconds" }, "$.steps[0].timeout", /cannot parse timeout "10 seconds"/],
    [{ click: "Go", command_timeout: -1 }, "$.steps[0].command_timeout", /cannot be negative/],
    [{ click: "Go", settle: "a while" }, "$.steps[0].settle", /cannot parse settle/],
    [{ sleep: "none" }, "$.steps[0].sleep", /`sleep` has to end/],
    [{ sleep: null }, "$.steps[0].sleep", /must be milliseconds.*got null/],
  ]) {
    assert.throws(
      () => validateSpec({ steps: [step] }),
      (e) => e instanceof SpecError && e.path === path && re.test(e.message),
      JSON.stringify(step),
    );
  }
  const ok = validateSpec({
    steps: [
      { click: "Go", timeout: "none", command_timeout: "2m", settle: "none" },
      { sleep: "2h" },
      { click: "Go", timeout: null },
    ],
  });
  assert.equal(ok.steps[0].commandTimeout, "2m", "snake_case in YAML, camelCase in the API");
  assert.equal(ok.steps[0].timeout, "none");
  assert.equal(ok.steps[1].sleep, "2h", "a long sleep is allowed; only an endless one is not");
  assert.equal(ok.steps[2].timeout, undefined, "a commented-out step timeout means the default");
});

// --- the no-timer path ---------------------------------------------------------

test("none, or a budget Node cannot time, arms no timer at all", () => {
  // setTimeout(fn, 2 ** 31) fires after about 1 ms with only a warning, so a
  // user asking for more time would get almost none.
  for (const ms of [Infinity, T.MAX_TIMER_MS, 2 ** 31, 1e15]) {
    assert.equal(T.hasDeadline(ms), false, String(ms));
    assert.equal(T.timerFor(ms, () => assert.fail("must never fire")), null, String(ms));
  }
  assert.equal(T.hasDeadline(T.MAX_TIMER_MS - 1), true);
  const timer = T.timerFor(10_000, () => {});
  assert.ok(timer, "an ordinary budget still gets its timer");
  clearTimeout(timer);
  assert.equal(T.describeBudget(Infinity), "no deadline");
  assert.equal(T.describeBudget(1500), "1500ms");
  assert.equal(T.describeSeconds(45_000), "45s");
  assert.equal(T.describeSeconds(1_500), "1.5s");
  assert.equal(T.describeSeconds(Infinity), "no deadline");
});

test("sleep waits past the timer limit instead of waking at once", () => {
  // Run in a child, which exits while the 24-day timer is still pending.
  const client = new URL("../dist/inspector/client.js", import.meta.url).href;
  const script =
    `import { sleep } from ${JSON.stringify(client)};\n` +
    `let woke = false; sleep(2 ** 31).then(() => { woke = true; });\n` +
    `setTimeout(() => { console.log(woke ? "woke" : "asleep"); process.exit(0); }, 150);\n`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.stdout.trim(), "asleep", `a 2^31 ms sleep must not end after a millisecond: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /TimeoutOverflowWarning/, "and no timer was ever asked for more than Node can time");
});

test("sleep still sleeps an ordinary amount", async () => {
  const t0 = Date.now();
  await sleep(40);
  assert.ok(Date.now() - t0 >= 35);
});

test("a log wait with no deadline waits for its line, and close() still releases it", async () => {
  for (const ms of [Infinity, 2 ** 31]) {
    const buf = new LogBuffer();
    const waiting = buf.waitFor((l) => l.text === "late", { timeoutMs: ms });
    let settled = false;
    waiting.then(() => (settled = true), () => (settled = true));
    await sleep(60);
    assert.equal(settled, false, `${ms}: it used to reject after ~1 ms`);
    buf.append("late", "stdout");
    assert.equal((await waiting).text, "late");
  }
  const closing = new LogBuffer();
  const parked = closing.waitFor(() => false, { timeoutMs: Infinity });
  closing.close("stopped");
  await assert.rejects(parked, LogWaitError);
});

// --- the inspector client ----------------------------------------------------

test("the default command deadline is the stock bridge window plus a margin", () => {
  const client = new InspectorClient({ host: "127.0.0.1", port: 1 });
  assert.equal(client.commandTimeoutMs, 30_000);
  assert.equal(client.commandTimeoutMs, T.DEFAULT_CALL_WINDOW_MS + T.COMMAND_MARGIN_MS);
  assert.ok(client.commandTimeoutMs > T.DEFAULT_CALL_WINDOW_MS, "strictly beyond it, or the bridge's own error is never seen");
  assert.equal(new InspectorClient({ host: "127.0.0.1", port: 1, timeoutMs: Infinity }).commandTimeoutMs, Infinity);
});

test("one command can carry its own deadline", { timeout: 5000 }, async (t) => {
  const port = await fakeInspector(t, () => {}); // never answers
  const client = new InspectorClient({ host: "127.0.0.1", port, timeoutMs: 4000 });
  t.after(() => client.disconnect());
  const t0 = Date.now();
  await assert.rejects(
    () => client.sendTimed("getTree", {}, { timeoutMs: 80 }),
    (err) => err instanceof InspectorTransportError && /"getTree" timed out after 80ms\./.test(err.message),
  );
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(client.commandTimeoutMs, 4000, "an override is for that one command");
});

test("withCommandTimeout scopes the deadline, nests, and restores it after a throw", { timeout: 5000 }, async (t) => {
  // A setup profile runs a second runner on the same client from inside the
  // first one's `open:` step, so scopes nest.
  const port = await fakeInspector(t, () => {});
  const client = new InspectorClient({ host: "127.0.0.1", port, timeoutMs: 4000 });
  t.after(() => client.disconnect());
  const out = await client.withCommandTimeout(3000, async () => {
    assert.equal(client.commandTimeoutMs, 3000);
    await client.withCommandTimeout(60, async () => {
      assert.equal(client.commandTimeoutMs, 60);
      await assert.rejects(() => client.getTree(), /timed out after 60ms/);
    });
    assert.equal(client.commandTimeoutMs, 3000, "the inner scope put the outer one back");
    return "done";
  });
  assert.equal(out, "done", "the scoped function's value comes back");
  assert.equal(client.commandTimeoutMs, 4000);
  await assert.rejects(() => client.withCommandTimeout(7, async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(client.commandTimeoutMs, 4000, "and so does a scope whose function threw");
  client.commandTimeoutMs = 1234;
  assert.equal(client.commandTimeoutMs, 1234, "a crawl re-derives it between clicks");
});

test("a command with no deadline waits for its reply, however late", { timeout: 5000 }, async (t) => {
  const port = await fakeInspector(t, (req, sock) => {
    realSetTimeout(() => answer(sock, req, { tree: { type: "QQuickView" } }), 150);
  });
  const client = new InspectorClient({ host: "127.0.0.1", port, timeoutMs: 50 });
  t.after(() => client.disconnect());
  for (const ms of [Infinity, 2 ** 31]) {
    const { data } = await client.sendTimed("getTree", {}, { timeoutMs: ms });
    assert.deepEqual(data.tree, { type: "QQuickView" }, `${ms}: it used to time out after ~1 ms`);
  }
  await assert.rejects(() => client.getTree(), /timed out after 50ms/, "the ordinary deadline is untouched");
});

// --- the bridge window ---------------------------------------------------------

test("the bridge window is read from the log's synchronous dispatch lines", () => {
  const buf = new LogBuffer();
  buf.append(DISPATCH(20_000), "stdout");
  buf.append('LogosAPIConsumer: async calling via LogosObject::callMethodAsync "checkForUpdates"', "stdout");
  buf.append("RemoteLogosObject: callRemoteMethod failed or timed out: 1", "stdout");
  buf.append(`[2026-09-24 21:31:48.123] [info] [medusa_core] ${DISPATCH(90_000, "claimFaucet")}`, "stdout");
  buf.append("some app said timeout: 999999 in its own words", "stdout");
  assert.equal(learnCallWindow(buf.slice(0)), 90_000, "the longest window a dispatch declared, and nothing else");
  assert.equal(learnCallWindow(buf.slice(0, 1)), 20_000);
  assert.equal(learnCallWindow(buf.slice(1, 3)), null, "async dispatches carry none, so none is learned");
});

test("the tracker reads each line once and keeps the longest window seen", () => {
  const buf = new LogBuffer();
  let read = 0;
  const logs = { slice: (from) => {
    const lines = buf.slice(from);
    read += lines.length;
    return lines;
  } };
  const tracker = new CallWindowTracker();
  assert.equal(tracker.observe(logs), null);
  buf.append(DISPATCH(20_000), "stdout");
  assert.equal(tracker.observe(logs), 20_000);
  buf.append(DISPATCH(60_000), "stdout");
  buf.append("unrelated", "stdout");
  assert.equal(tracker.observe(logs), 60_000);
  buf.append(DISPATCH(20_000), "stdout");
  assert.equal(tracker.observe(logs), 60_000, "a later short call does not shrink the window");
  assert.equal(tracker.observe(logs), 60_000);
  assert.equal(read, 4, "every line read exactly once, however often it is asked");
});

test("defaults follow the bridge window instead of assuming 20 s", () => {
  assert.equal(T.commandTimeoutFor(20_000), 30_000);
  assert.equal(T.commandTimeoutFor(120_000), 130_000);
  assert.equal(T.commandTimeoutFor(Infinity), Infinity);
  assert.equal(T.defaultStepTimeout(20_000), 30_000, "exactly the old default on a stock Basecamp");
  assert.equal(T.defaultStepTimeout(5_000), 30_000);
  assert.equal(T.defaultStepTimeout(60_000), 70_000);
  assert.equal(outsideCommandTimeout({}), 30_000);
  assert.equal(outsideCommandTimeout({ callTimeoutMs: 90_000 }), 100_000);
  assert.equal(outsideCommandTimeout({ callTimeoutMs: 90_000, commandTimeoutMs: 5_000 }), 5_000, "the flag is the deadline outright");
});

// --- what each step resolves to -------------------------------------------------

/** Enough of a session for a Runner, with a plain-object inspector. */
function fakeSession(inspector = {}) {
  return {
    logs: new LogBuffer(),
    inspector: {
      getTree: async () => ({ tree: { id: "root", type: "Item", children: [] } }),
      evaluate: async () => ({ result: true }),
      ...inspector,
    },
  };
}

const budgets = (spec, opts = {}, session = fakeSession()) =>
  new Runner({
    session,
    spec: { steps: [{ click: "x" }], ...spec },
    appName: "a",
    logsUsable: false,
    onNote: () => {},
    ...opts,
  });

test("most specific wins: the step, then the spec, then the command line, then the default", () => {
  const cli = { stepTimeoutMs: 1_000, commandTimeoutMs: 2_000, settleMs: 3_000 };
  const header = { timeout: "40s", commandTimeout: "50s", settle: "2s" };

  const both = budgets(header, cli);
  assert.deepEqual(both.budgetFor({ click: "x" }), { timeoutMs: 40_000, commandMs: 50_000, settleMs: 2_000, callWindowMs: 20_000 });
  assert.deepEqual(
    both.budgetFor({ click: "x", timeout: "5s", commandTimeout: "7s", settle: "none" }),
    { timeoutMs: 5_000, commandMs: 7_000, settleMs: Infinity, callWindowMs: 20_000, ownTimeoutMs: 5_000 },
  );
  assert.deepEqual(budgets({}, cli).budgetFor({ click: "x" }), { timeoutMs: 1_000, commandMs: 2_000, settleMs: 3_000, callWindowMs: 20_000 });
  assert.deepEqual(
    budgets({}).budgetFor({ click: "x" }),
    { timeoutMs: 30_000, commandMs: 30_000, settleMs: 1_000, callWindowMs: 20_000 },
    "a spec that sets nothing gets exactly what it always did, except a 30 s command deadline for 20 s",
  );
});

test("a step's timeout governs every command in it, and never goes under the bridge window", () => {
  // The Medusa shape: `timeout: 60s` on the spec, nothing on the step, and a
  // synchronous call inside it. Each command now gets the minute it was given.
  assert.equal(budgets({ timeout: "60s" }).budgetFor({ eval: "root.callGated('listAccounts')" }).commandMs, 60_000);
  assert.equal(budgets({}).budgetFor({ click: "x", timeout: "90s" }).commandMs, 90_000);
  assert.equal(budgets({}).budgetFor({ click: "x", timeout: "1s" }).commandMs, 30_000, "a short step still outlasts the bridge");
  assert.equal(budgets({}).budgetFor({ click: "x", timeout: "none" }).commandMs, Infinity);
  // The explicit knob is how a long wait keeps fast hang detection.
  assert.equal(budgets({}).budgetFor({ waitFor: { text: ["x"] }, timeout: "10m", commandTimeout: "5s" }).commandMs, 5_000);
});

test("a Basecamp with a longer bridge window raises the defaults as soon as the log shows it", () => {
  const session = fakeSession();
  const runner = budgets({}, {}, session);
  assert.equal(runner.callWindow(), 20_000, "nothing logged yet: the stock window");
  session.logs.append(DISPATCH(60_000), "stdout");
  assert.deepEqual(runner.budgetFor({ click: "x" }), { timeoutMs: 70_000, commandMs: 70_000, settleMs: 1_000, callWindowMs: 60_000 });
  // Declared wins over learned: the spec first, then the command line.
  assert.equal(budgets({}, { callTimeoutMs: 25_000 }, session).budgetFor({ click: "x" }).commandMs, 35_000);
  assert.equal(budgets({ callTimeout: "45s" }, { callTimeoutMs: 25_000 }, session).budgetFor({ click: "x" }).commandMs, 55_000);
});

test("a budget a hand-built spec got wrong fails its step, not the whole run", async () => {
  // validateSpec refuses these at load; a library caller can skip it.
  const runner = budgets({ steps: [{ click: "x", timeout: "whenever" }, { click: "y" }] });
  const result = await runner.run();
  assert.equal(result.steps[0].verdict, "fail");
  assert.match(result.steps[0].error, /cannot parse duration "whenever"/);
  assert.equal(result.steps[1].verdict, "inconclusive", "and the rest are accounted for, not lost");
});

// --- the slow call that started this -------------------------------------------

/**
 * A step whose `eval:` the app answers after `replyMs`, run against the real
 * client on virtual time, so a call slower than 20 s costs milliseconds.
 */
async function slowEval(t, { replyMs, spec, step }) {
  const port = await fakeInspector(t, (req, sock) => {
    if (req.command === "evaluate") setTimeout(() => answer(sock, req, { result: "ok" }), replyMs);
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const client = new InspectorClient({ host: "127.0.0.1", port });
  t.after(() => client.disconnect());
  const runner = new Runner({
    session: { inspector: client, logs: new LogBuffer() },
    spec: { app: "medusa_ui", ...spec, steps: [{ eval: "root.callGated('listAccounts')", ...step }] },
    appName: "medusa_ui",
    logsUsable: false,
    initialScope: { module: "medusa_ui", scope: { dockId: "dock", qmlRootId: "root", scopeId: "root" } },
    onNote: () => {},
  });
  const t0 = Date.now();
  let result = null;
  const running = runner.run().then((r) => (result = r));
  for (let i = 0; i < 400 && result === null; i++) {
    t.mock.timers.tick(250);
    await realPause(1);
  }
  await running;
  return { step: result.steps[0], virtualMs: Date.now() - t0 };
}

test("a synchronous call slower than 20 s passes when the step's timeout covers it", { timeout: 20_000 }, async (t) => {
  const { step, virtualMs } = await slowEval(t, { replyMs: 45_000, spec: { timeout: "60s" }, step: {} });
  assert.equal(step.verdict, "pass", step.error);
  assert.ok(virtualMs >= 45_000, `the reply really was 45 s late (${virtualMs}ms)`);
});

test("with no timeout anywhere, a call the bridge answers at 25 s is still seen through", { timeout: 20_000 }, async (t) => {
  // The command deadline is never under the bridge window plus 10 s.
  const { step } = await slowEval(t, { replyMs: 25_000, spec: {}, step: {} });
  assert.equal(step.verdict, "pass", step.error);
});

test("an explicit command_timeout below the step's timeout trips first", { timeout: 20_000 }, async (t) => {
  const { step, virtualMs } = await slowEval(t, { replyMs: 25_000, spec: {}, step: { timeout: "60s", commandTimeout: "20s" } });
  assert.equal(step.verdict, "fail");
  assert.match(step.error, /inspector command "evaluate" timed out after 20000ms\./);
  assert.match(step.error, /raise command_timeout/, "and says which knob it was");
  assert.ok(virtualMs < 25_000, `it gave up at the command deadline, not at the reply (${virtualMs}ms)`);
});

// --- no hidden floors -------------------------------------------------------------

test("a step whose action spent its budget checks its expectations once, with no hidden extra second", async () => {
  let reads = 0;
  const session = fakeSession({
    getTree: async () => {
      reads++;
      return { tree: { id: "root", type: "Item", children: [] } };
    },
  });
  const runner = budgets({ steps: [{ sleep: "150ms", timeout: "50ms", expect: { text: ["Absent"] } }] }, {}, session);
  const t0 = Date.now();
  const result = await runner.run();
  const elapsed = Date.now() - t0;
  assert.equal(result.steps[0].verdict, "fail");
  assert.equal(reads, 1, "checked exactly once");
  assert.ok(elapsed < 900, `the old floor polled a further second (took ${elapsed}ms)`);
});

test("an open on its own budget is not charged to the step's expectations", async () => {
  // Opening an app is not the step's work. Charging it left an expectation
  // right after a slow open with no time at all to see the app render.
  const t0 = Date.now();
  let dockAt = null;
  const tree = () => ({
    id: "dock-1",
    type: "QDockWidget",
    children: [{
      id: "root",
      type: "Main_QMLTYPE_1",
      children: dockAt !== null && Date.now() - dockAt > 150
        ? [{ id: "t", type: "Text", text: "Ready", visible: true, enabled: true, children: [] }]
        : [],
    }],
  });
  const session = fakeSession({
    findAndClick: async () => ({}),
    findByProperty: async (_prop, value) => {
      if (value !== "tip_jar" || Date.now() - t0 < 500) return { matches: [] };
      dockAt ??= Date.now();
      return { matches: [{ id: "dock-1" }] };
    },
    getTree: async () => ({ tree: tree() }),
  });
  const runner = budgets(
    { app: "tip_jar", timeout: "300ms", openSettle: "0ms", steps: [{ open: "tip_jar", expect: { text: ["Ready"] } }] },
    {},
    session,
  );
  const result = await runner.run();
  assert.equal(result.steps[0].verdict, "pass", JSON.stringify(result.steps[0].checks));
});

// --- setup profiles and the command line ---------------------------------------

test("a setup profile inherits the command line's budgets", async () => {
  const session = fakeSession();
  const host = { session, fidelity: { fidelity: "quiet" }, timeouts: { stepTimeoutMs: 150 } };
  const t0 = Date.now();
  const out = await runSetupProfile(
    host,
    { file: "p.setup.yaml", spec: { steps: [{ name: "waits", waitFor: { text: ["Never"] } }] } },
    "a",
    "spec",
    true,
  );
  assert.ok(out.failed, "the wait could not come true");
  assert.ok(Date.now() - t0 < 5_000, "on --step-timeout's 150 ms, not the 30 s default");
});

test("a duration flag is read the way the spec reads one, and refused when it cannot be", () => {
  assert.equal(durationFlag("timeout", "30s"), 30_000, "--timeout 30s used to be silently ignored");
  assert.equal(durationFlag("timeout", "30000"), 30_000);
  assert.equal(durationFlag("command-timeout", "none"), Infinity);
  assert.equal(durationFlag("call-timeout", "1h"), 3_600_000);
  assert.equal(durationFlag("timeout", undefined), undefined);
  assert.throws(
    () => durationFlag("step-timeout", "soon"),
    (e) => e instanceof ArgError && /--step-timeout "soon"/.test(e.message) && /"none" for no deadline/.test(e.hint),
  );
  assert.throws(() => durationFlag("open-timeout", "-3s"), (e) => e instanceof ArgError && /negative/.test(e.message));
  assert.throws(() => durationFlag("settle", "none", true), (e) => e instanceof ArgError && /has to end/.test(e.message));
});

test("main hands every budget to boot, and refuses a bad one before booting", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-timeouts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec = path.join(dir, "spec.yaml");
  fs.writeFileSync(spec, "steps:\n  - click: Go\n");
  let seen = null;
  const stop = { boot: async (opts) => {
    seen = opts;
    throw new Error("stop here: the options are what this test is about");
  } };
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(() => main([
      "inspect", "demo_ui", "--timeout", "30s", "--step-timeout", "1h", "--command-timeout", "none",
      "--call-timeout", "90s", "--open-timeout", "2m",
    ], stop), /stop here/);
    assert.equal(seen.timeoutMs, 30_000);
    assert.equal(seen.stepTimeoutMs, 3_600_000);
    assert.equal(seen.commandTimeoutMs, Infinity);
    assert.equal(seen.callTimeoutMs, 90_000);
    assert.equal(seen.openTimeoutMs, 120_000);

    await assert.rejects(() => main(["run", spec, "--settle", "none"], stop), /stop here/);
    assert.equal(seen.settleMs, Infinity, "run takes --settle now, and none is allowed for it");
    await assert.rejects(() => main(["demo_ui", "--settle", "none"], stop), ArgError, "a crawl's settle has to end");

    seen = null;
    await assert.rejects(() => main(["run", spec, "--command-timeout", "soon"], stop), ArgError);
    assert.equal(seen, null, "refused before anything was booted");
  } finally {
    console.log = log;
    console.error = err;
  }
});

test("the click window shrinks with a short open budget, so the launcher fallback gets a turn", () => {
  assert.equal(clickWindowFor(120_000), 15_000);
  assert.equal(clickWindowFor(6_000), 2_000);
  assert.equal(clickWindowFor(Infinity), 15_000);
});

test("the open budget flags: --open-timeout is chosen, --timeout is a fallback", () => {
  assert.deepEqual(T.openBudgetFrom({}), { explicit: false });
  assert.deepEqual(T.openBudgetFrom({ timeoutMs: 5_000 }), { timeoutMs: 5_000, explicit: false });
  assert.deepEqual(T.openBudgetFrom({ timeoutMs: 5_000, openTimeoutMs: 9_000 }), { timeoutMs: 9_000, explicit: true });
  assert.deepEqual(
    T.timeoutFlagsOf({ timeoutMs: 1, stepTimeoutMs: 2, commandTimeoutMs: 3, callTimeoutMs: 4, openTimeoutMs: 5, app: "x" }),
    { timeoutMs: 1, stepTimeoutMs: 2, commandTimeoutMs: 3, callTimeoutMs: 4, openTimeoutMs: 5 },
  );
  assert.deepEqual(T.timeoutFlagsOf({ app: "x" }), {});
});
