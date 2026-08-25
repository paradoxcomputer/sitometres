// The crawl's CI gate: what counts as a failure, and what the process exits.
//
// This is the regression of commit 73b8008. A crawl of an app whose backend
// call timed out printed the timeout, exited 0, and wrote a JUnit file saying
// failures="0" — a green CI job over a broken app. Nothing in the suite could
// have caught it: all three decisions below lived inline in the body of
// `smoke()`, an un-exported async function that opens a Basecamp, so no test
// called them and the sweep was "verified" by a regex over this file's source
// text. They are exported now, and these are the tests that would have failed.
//
// The load-bearing fact is the arithmetic of time: the transport gives up on a
// reply after 20 s, and the crawl watches each click for 2.5 s, so the failure
// line of a timeout NEVER lands in the window of the click that caused it.
//
// What actually shipped, per `git show 73b8008`, is the sweep that skipped a
// failure whenever its DISPATCH fell inside any window — which is true of every
// timeout, since the dispatch is exactly what the click did — so every timeout
// was treated as already graded and disappeared from the run. The rule now is
// narrower: a failure is accounted for only when ONE window holds both the
// dispatch and the failure line, i.e. the click that caused it also saw it.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine, pairFailures, UNATTRIBUTED } from "../dist/logs/classify.js";
import { reconcileLateFailures, crawlExitCode, crawlProvedNothing } from "../dist/commands/smoke.js";

// Line shapes copied from the real corpus in
// ~/.local/share/Logos/LogosBasecampDev/logs: the module-qualified dispatch,
// the transport call that blocks on the reply, and the failure line — which
// names neither module nor method, which is why any of this is hard.
const dispatch = (mod, method, args) =>
  `LogosAPIClient: invoking remote method "${mod}" "${method}" args_count: ${args}`;
const transport = (method, args) => `[LogosObject] RemoteLogosObject::callMethod "${method}" args: ${args}`;
const TIMED_OUT = "RemoteLogosObject: callRemoteMethod failed or timed out: 1";

/**
 * A crawl's log, with one window per click recorded exactly as the crawl
 * records one: mark(), click, settle, mark(). Pairing runs over the whole run
 * — from the moment the app opened — not over each window, because a window is
 * far too short to contain both halves of a timeout.
 */
function crawled(script) {
  const logs = new LogBuffer();
  const windows = [];
  for (const [label, lines] of script) {
    const from = logs.mark();
    for (const l of lines) logs.append(l, "stdout");
    windows.push({ label, from, to: logs.mark() });
  }
  return { paired: pairFailures(logs.slice(0).map(parseLine)), windows };
}

/**
 * Three clicks. "Refresh" fails fast, within its own window. "Send tip"
 * dispatches and hears nothing; its timeout arrives 20 s later, while an
 * innocent "Check balance" is being watched, along with a second failure that
 * no dispatch at all can be matched to.
 */
const aCrawl = () =>
  crawled([
    ["Refresh", [dispatch("medusa_core", "refresh", 0), transport("refresh", 0), TIMED_OUT]],
    ["Send tip", [dispatch("medusa_core", "sendTip", 1), transport("sendTip", 1)]],
    ["Check balance", [TIMED_OUT, TIMED_OUT]],
  ]);

// --- which failures no click accounted for -----------------------------------

test("a failure the dispatching click also watched fail is not reported again", () => {
  // "Refresh" dispatched at seq 1 and saw the failure at seq 2, both inside its
  // own window, so its own grading already counted it. Reporting it here would
  // charge the run twice for one broken call.
  const { paired, windows } = aCrawl();
  const late = reconcileLateFailures(paired, windows, []);
  assert.equal(
    late.some((l) => l.includes("refresh")),
    false,
    `refresh was graded by its own click; late failures were ${JSON.stringify(late)}`,
  );
});

test("a timeout that outlives its window is reported, naming the click that dispatched it", () => {
  // The regression itself. sendTip is dispatched during "Send tip" and fails
  // during "Check balance", which is where every real timeout lands. Judged by
  // its failure line it belongs to an innocent click; judged by its anchor it
  // is inside a closed window and used to vanish, exit code 0.
  const { paired, windows } = aCrawl();
  const late = reconcileLateFailures(paired, windows, []);
  assert.deepEqual(late, ['medusa_core.sendTip (dispatched by "Send tip")', "a call"]);
  assert.equal(
    late.some((l) => l.includes("Check balance")),
    false,
    "the click that happened to be running is not the one that broke",
  );
});

test("a failure no dispatch could be matched to is still reported, unattributed", () => {
  // There is no correlation id in this log, so a failure whose anchor was
  // already consumed cannot be named. It is a real backend failure regardless,
  // and dropping the unnameable ones is how a burst of 22 reported as 1.
  const { paired, windows } = aCrawl();
  const orphan = [...paired.values()].filter((f) => f.method === UNATTRIBUTED);
  assert.equal(orphan.length, 1, "the fixture has exactly one failure with nothing to pair to");
  assert.equal(orphan[0].anchorSeq, undefined);
  assert.deepEqual(
    reconcileLateFailures(paired, windows, []).filter((l) => l === "a call"),
    ["a call"],
    "an unattributable failure is named vaguely, not discarded",
  );
});

test("--ignore-calls silences the poll it names and nothing else", () => {
  const { paired, windows } = aCrawl();
  assert.deepEqual(
    reconcileLateFailures(paired, windows, ["medusa_core.sendTip"]),
    ["a call"],
    "the named call goes; the one that could not be named cannot have been named here",
  );
  assert.deepEqual(
    reconcileLateFailures(paired, windows, [UNATTRIBUTED]),
    ['medusa_core.sendTip (dispatched by "Send tip")'],
    "an unattributed failure is silenced only by asking for that explicitly",
  );
  assert.deepEqual(
    reconcileLateFailures(paired, windows, ["some_other_module.sendTip"]),
    ['medusa_core.sendTip (dispatched by "Send tip")', "a call"],
    "another module's identically-named method must not silence this one",
  );
});

test("the click named in a late failure is shortened, not printed whole", () => {
  // Labels come from the app's own UI and can be a paragraph. The console line
  // is one per failure and has to stay readable.
  const long = "Send the entire wallet balance to the clipboard address";
  const { paired, windows } = crawled([
    ["Refresh", []],
    [long, [dispatch("medusa_core", "sendTip", 1), transport("sendTip", 1)]],
    ["Check balance", [TIMED_OUT]],
  ]);
  assert.deepEqual(paired.size, 1);
  assert.deepEqual(reconcileLateFailures(paired, windows, []), [
    'medusa_core.sendTip (dispatched by "Send the entire wallet balance to the cli…")',
  ]);
});

// --- the exit code -----------------------------------------------------------

test("a crawl with problems exits 1 whether or not --strict was asked for", () => {
  assert.equal(crawlExitCode({ problems: 1, provedNothing: false, evidenceUnreadable: false }), 1);
  assert.equal(
    crawlExitCode({ problems: 3, strict: true, provedNothing: false, evidenceUnreadable: false }),
    1,
  );
  assert.equal(
    crawlExitCode({ problems: 1, strict: false, provedNothing: true, evidenceUnreadable: true }),
    1,
    "a problem is a problem regardless of what --strict would have said",
  );
});

test("--strict passes a healthy crawl", () => {
  // The other half of the gate's history: --strict was wired to the per-control
  // outcome, so it failed every healthy crawl and nobody could leave it on.
  assert.equal(
    crawlExitCode({ problems: 0, strict: true, provedNothing: false, evidenceUnreadable: false }),
    0,
  );
});

test("--strict fails a crawl that proved nothing, or whose evidence could not be read", () => {
  assert.equal(
    crawlExitCode({ problems: 0, strict: true, provedNothing: true, evidenceUnreadable: false }),
    1,
  );
  assert.equal(
    crawlExitCode({ problems: 0, strict: true, provedNothing: false, evidenceUnreadable: true }),
    1,
    "evidence that cannot be read is not evidence of success",
  );
});

test("without --strict, neither proving nothing nor unreadable evidence fails the run", () => {
  assert.equal(
    crawlExitCode({ problems: 0, provedNothing: true, evidenceUnreadable: true }),
    0,
    "the default crawl reports these; only --strict gates on them",
  );
  assert.equal(
    crawlExitCode({ problems: 0, strict: false, provedNothing: true, evidenceUnreadable: true }),
    0,
  );
});

// --- did the crawl prove anything at all? ------------------------------------

test("a crawl that clicked nothing proved nothing", () => {
  assert.equal(crawlProvedNothing([]), true);
});

test("controls that did nothing observable prove nothing", () => {
  assert.equal(
    crawlProvedNothing([
      { outcome: "nothing", calls: [] },
      { outcome: "nothing", calls: [] },
    ]),
    true,
  );
});

test("one dispatched call is enough to have proved something", () => {
  assert.equal(
    crawlProvedNothing([
      { outcome: "nothing", calls: [] },
      { outcome: "ran", calls: ["medusa_core.getBalance"] },
    ]),
    false,
  );
});

test("a control the app itself reported success for proves something without any call", () => {
  assert.equal(crawlProvedNothing([{ outcome: "worked", calls: [] }]), false);
});

test("an unclear control that dispatched a call has not proved nothing", () => {
  // `unclear` is the ordinary outcome for most controls in a real app —
  // something happened and the log does not say what. Reading it as "proved
  // nothing" is what made --strict fail every healthy crawl.
  assert.equal(crawlProvedNothing([{ outcome: "unclear", calls: ["medusa_core.connectRequest"] }]), false);
});

// --- the two halves together, which is where the gate actually broke ---------

test("a crawl whose only failure arrived after its window still exits 1", () => {
  // End to end over the exported pieces: this is the shipped bug. Every click
  // graded clean, one backend call timed out 20 s after the click that made it,
  // and the process exited 0 with failures="0" in the JUnit file.
  const { paired, windows } = aCrawl();
  const problems = reconcileLateFailures(paired, windows, []).length;
  assert.equal(problems, 2);
  assert.equal(crawlExitCode({ problems, provedNothing: false, evidenceUnreadable: false }), 1);
});
