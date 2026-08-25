// The interactive status line — the half of report/status.ts nothing executed.
//
// Off a TTY the line is one plain stderr sentence per step, and that path has
// tests. On a TTY it is a different program: a spinner rewritten in place, and a
// takeover of console.log for as long as the line is live. Neither had ever been
// run by the suite, which means both of the defects the source names were being
// guarded by their comments alone:
//
//   * a print landing straight on top of a live line, which is how a report ends
//     up reading `Running · …asking Basecamp  FAIL open zonescan_lite`. The
//     override has to erase, print, and redraw, in that order.
//   * clear() erasing once but leaving the 100 ms ticker running, so anything
//     that then waited for the user — the debug prompt, the first-run Basecamp
//     question — had its prompt wiped ~100 ms after it appeared. suspend() must
//     stop the timer, not just blank the row.
//
// No Basecamp and no terminal: process.stdout.write is stubbed, isTTY and
// columns are faked, and Date.now is frozen so the elapsed counter is an exact
// value rather than "approximately zero". Everything is put back in a finally —
// a leaked console.log override would silently eat every later test's output.

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

// The colour constants inside status.js are frozen at import time from
// process.stdout.isTTY, and under `node --test` stdout is a pipe. Imported the
// ordinary way, every escape below would collapse to "" and the tints — the
// difference between a run that failed and a run that passed — would be
// untestable.
const outerTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const outerNoColor = process.env.NO_COLOR;
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
delete process.env.NO_COLOR;
const { status } = await import("../dist/report/status.js");
if (outerTTY) Object.defineProperty(process.stdout, "isTTY", outerTTY);
else delete process.stdout.isTTY;
if (outerNoColor === undefined) delete process.env.NO_COLOR;
else process.env.NO_COLOR = outerNoColor;

const CLEAR = "\x1b[2K\r";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const CYA = "\x1b[36m";
const GRN = "\x1b[32m";
const RED = "\x1b[31m";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The exact bytes one repaint of a live line is expected to be. */
const painted = (spin, tint, phase, detail, secs) =>
  `${CLEAR}  ${tint}${spin} ${phase}${RST} ${DIM}·${RST} ${detail} ${DIM}${secs}${RST}`;

/** What a repaint looks like with the escape codes taken back off. */
const visible = (line) => line.replace(CLEAR, "").replace(/\x1b\[\d+m/g, "");

/**
 * Which of the ten frames a repaint is showing.
 *
 * The spinner carries over from wherever the previous live line left it — a
 * status line is a singleton and nothing resets the frame — so a test predicts
 * the sequence from the frame it opened on rather than assuming the first one.
 */
function openingFrame(line) {
  const at = FRAMES.indexOf(visible(line).slice(2, 3));
  assert.ok(at >= 0, `the opening paint is not showing a spinner frame: ${JSON.stringify(line)}`);
  return at;
}

/**
 * A terminal the status line can have all to itself.
 *
 * Only the line's own writes are captured — everything a status repaint emits
 * begins with the erase code — and anything else is passed through, so the test
 * reporter's output still reaches the real stdout instead of vanishing into the
 * array.
 */
function terminal({ columns = 80 } = {}) {
  const writes = [];
  const events = [];
  const saved = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
    write: process.stdout.write,
    log: console.log,
    now: Date.now,
    noStatus: process.env.SITOMETRES_NO_STATUS,
  };
  let clock = 1_600_000_000_000;

  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  delete process.env.SITOMETRES_NO_STATUS;
  Date.now = () => clock;
  process.stdout.write = function (chunk, ...rest) {
    const text = String(chunk);
    if (!text.startsWith(CLEAR)) return saved.write.call(process.stdout, chunk, ...rest);
    writes.push(text);
    events.push(["write", text]);
    return true;
  };

  return {
    writes,
    events,
    /** Move the frozen clock on, the way a slow plugin would. */
    advance(ms) {
      clock += ms;
    },
    /** Stand in for the printing the rest of the tool does with console.log. */
    spyLog() {
      const spy = (...args) => void events.push(["log", args]);
      console.log = spy;
      return spy;
    },
    restore() {
      status.stop(); // never leave the singleton live, or its ticker running
      Date.now = saved.now;
      console.log = saved.log;
      process.stdout.write = saved.write;
      if (saved.isTTY) Object.defineProperty(process.stdout, "isTTY", saved.isTTY);
      else delete process.stdout.isTTY;
      if (saved.columns) Object.defineProperty(process.stdout, "columns", saved.columns);
      else delete process.stdout.columns;
      if (saved.noStatus === undefined) delete process.env.SITOMETRES_NO_STATUS;
      else process.env.SITOMETRES_NO_STATUS = saved.noStatus;
    },
  };
}

/** Wait for the real 100 ms ticker. Cannot use Date.now — it is frozen. */
async function until(condition, what) {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("a live line is rewritten in place, and says the phase and detail it was set to", () => {
  const t = terminal();
  try {
    status.start("Preparing");
    assert.equal(t.writes.length, 1, "start paints the line once, immediately");
    const spin = FRAMES[openingFrame(t.writes[0])];
    assert.equal(
      t.writes[0],
      `${CLEAR}  ${CYA}${spin} Preparing${RST} ${DIM}0s${RST}`,
      "with no detail yet there is no dangling separator",
    );

    status.set("Preparing", "staging tip_jar");
    assert.equal(t.writes[1], painted(spin, CYA, "Preparing", "staging tip_jar", "0s"));

    status.set("Running", "step 3/9: click Donate");
    assert.equal(t.writes[2], painted(spin, CYA, "Running", "step 3/9: click Donate", "0s"));

    status.detailOnly("waiting for the dock");
    assert.equal(
      t.writes[3],
      painted(spin, CYA, "Running", "waiting for the dock", "0s"),
      "detailOnly changes the detail and keeps the phase it was already in",
    );

    assert.ok(
      t.writes.every((w) => w.startsWith(CLEAR)),
      "every repaint erases the row it is about to overwrite",
    );
    assert.ok(
      t.writes.every((w) => !w.includes("\n")),
      "and never ends a line: this is one row rewritten, not nine lines of log",
    );
  } finally {
    t.restore();
  }
});

test("a narrow terminal truncates the detail rather than wrapping the row", () => {
  // \x1b[2K erases one PHYSICAL line, so a status line one column too wide
  // leaves its tail on screen and every later print lands beside the leftovers.
  // fitDetail has its own test; what is checked here is that render actually
  // asks it, with the real terminal width rather than an assumed 80.
  const t = terminal({ columns: 40 });
  try {
    status.start("Running", 'sidebar has not rendered "ZoneScan Lite" — asking Basecamp to open it');
    const spin = FRAMES[openingFrame(t.writes[0])];
    assert.equal(t.writes[0], painted(spin, CYA, "Running", "sidebar has not render…", "0s"));

    const row = visible(t.writes[0]);
    assert.equal(row, `  ${spin} Running · sidebar has not render… 0s`);
    assert.equal(row.length, 40, "exactly full, never one column over");
  } finally {
    t.restore();
  }
});

test("a terminal phase stops the spinner, and the frozen line is red when the run failed", () => {
  const t = terminal();
  try {
    status.start("Running", "step 9/9: click Send");
    t.advance(17_400);

    status.set("Failed", "no call to wallet.send");
    assert.equal(
      t.writes[1],
      painted(" ", RED, "Failed", "no call to wallet.send", "17s"),
      "nothing is still spinning once it is over, and a failure is not tinted green",
    );

    status.stop("Failed", "1 of 9 steps failed");
    assert.equal(
      t.writes[2],
      `${CLEAR}  ${RED}Failed${RST} ${DIM}·${RST} 1 of 9 steps failed ${DIM}in 17s${RST}\n`,
      "stop freezes the line, prints how long the run took, and ends the row",
    );

    const frozen = t.writes.length;
    status.set("Running", "a late set from a straggler");
    assert.equal(t.writes.length, frozen, "a stopped line does not come back to life over the report");
  } finally {
    t.restore();
  }
});

test("a console.log while the line is live is erased, printed above, and the line redrawn", () => {
  // This is why the takeover exists. Printing over the top of the spinner is
  // what produced `Running · …asking Basecamp  FAIL open zonescan_lite`: one
  // physical row holding half a status line and half a result.
  const t = terminal();
  try {
    const printed = t.spyLog(); // the console.log the rest of the tool prints with
    status.start("Running", "step 4/9: click Donate");
    assert.notEqual(console.log, printed, "start takes console.log over while the line is live");
    const spin = FRAMES[openingFrame(t.writes[0])];
    t.events.length = 0;

    console.log("  FAIL", "open zonescan_lite");

    assert.deepEqual(
      t.events,
      [
        ["write", CLEAR],
        ["log", ["  FAIL", "open zonescan_lite"]],
        ["write", painted(spin, CYA, "Running", "step 4/9: click Donate", "0s")],
      ],
      "erase, hand every argument to the real console.log, then redraw — in that order",
    );

    status.stop("Completed", "9 steps, 22 checks");
    assert.equal(console.log, printed, "stop hands console.log back");

    t.events.length = 0;
    console.log("the report itself");
    assert.deepEqual(
      t.events,
      [["log", ["the report itself"]]],
      "and once it is handed back nothing is intercepted or erased any more",
    );
  } finally {
    t.restore();
  }
});

test("the ticker advances the spinner and re-renders the elapsed seconds", async () => {
  // The heartbeat is the whole point of the line: staging a tree or waiting for
  // medusa_ui's dock is a silent minute, and without this the tool looks hung
  // exactly when it is working hardest.
  const t = terminal();
  try {
    status.start("Running", "waiting for the dock");
    const base = openingFrame(t.writes[0]);
    assert.equal(t.writes[0], painted(FRAMES[base], CYA, "Running", "waiting for the dock", "0s"));

    t.advance(17_400);
    await until(() => t.writes.length > 1, "the first tick");
    assert.equal(
      t.writes[1],
      painted(FRAMES[(base + 1) % 10], CYA, "Running", "waiting for the dock", "17s"),
      "one frame further on, and the counter caught up without anyone calling set",
    );

    t.advance(200); // 17.6s
    const n = t.writes.length;
    await until(() => t.writes.length > n, "the next tick");
    assert.equal(
      t.writes[n],
      painted(FRAMES[(base + n) % 10], CYA, "Running", "waiting for the dock", "18s"),
      "seconds are rounded, not truncated, and the frame is the nth in order",
    );

    status.stop("Completed");
  } finally {
    t.restore();
  }
});

test("suspend stops the ticker, so a prompt that follows it is not wiped 100 ms later", async () => {
  // The defect suspend() exists for: clear() blanked the row but left the timer
  // running, so the debug prompt and the first-run Basecamp question were erased
  // a tenth of a second after they were printed, with the cursor left wherever
  // the spinner had put it.
  const t = terminal();
  try {
    status.start("Running", "step 6/9: confirm");
    const base = openingFrame(t.writes[0]);
    await until(() => t.writes.length > 1, "the ticker to start");

    status.suspend();
    assert.equal(t.writes.at(-1), CLEAR, "suspend erases the row and writes nothing over it");
    const quiet = t.writes.length;

    await sleep(350); // three ticks' worth
    assert.equal(
      t.writes.length,
      quiet,
      "and then stays silent: nothing may repaint while the terminal is somebody else's",
    );

    // writes so far: the opening paint, one per tick, and suspend's erase.
    const ticks = quiet - 2;
    status.resume();
    assert.equal(t.writes.length, quiet, "resume does not paint immediately; it waits for the next tick");

    await until(() => t.writes.length > quiet, "the ticker to come back");
    assert.equal(
      t.writes[quiet],
      painted(FRAMES[(base + ticks + 1) % 10], CYA, "Running", "step 6/9: confirm", "0s"),
      "repainting resumes on the phase and detail it was suspended on, one frame further on",
    );

    status.stop("Completed");
  } finally {
    t.restore();
  }
});

test("resume never stacks a second ticker, and a stopped line has none left", async () => {
  // A duplicate interval on one row is invisible until it doubles the repaint
  // rate: stop() clears the one timer it knows about and the other survives the
  // run, so the next line is painted twice as fast by two spinners disagreeing
  // about the frame. Both of resume's guards — already ticking, and not live —
  // are checked by counting repaints in a fixed window. A stacked ticker can
  // only add paints and a loaded machine can only remove them, so the ceiling is
  // the end that is safe to assert.
  const t = terminal();
  try {
    status.start("Running", "step 2/9: type 4.20");
    const base = openingFrame(t.writes[0]);
    status.resume(); // already ticking
    status.resume();

    status.stop("Completed", "9 steps, 22 checks");
    assert.equal(
      t.writes.at(-1),
      `${CLEAR}  ${GRN}Completed${RST} ${DIM}·${RST} 9 steps, 22 checks ${DIM}in 0s${RST}\n`,
      "a run that passed ends on one green frozen line",
    );

    status.resume(); // not live
    const ended = t.writes.length;
    await sleep(320);
    assert.equal(t.writes.length, ended, "a stopped line never repaints again");

    // A second line in the same process: any ticker left over from the first
    // one starts painting again the moment there is something to paint.
    status.start("Running", "step 3/9: click Donate");
    const opened = t.writes.length;
    assert.equal(
      t.writes[opened - 1],
      painted(FRAMES[base], CYA, "Running", "step 3/9: click Donate", "0s"),
      "the new line opens on the frame the old one stopped on",
    );

    await sleep(320);
    const paints = t.writes.length - opened;
    assert.ok(paints >= 1, "the new line's own ticker is running");
    assert.ok(
      paints <= 5,
      `one ticker repaints about three times in 320 ms; got ${paints} — a second interval is running`,
    );
    assert.equal(
      t.writes.at(-1),
      painted(FRAMES[(base + paints) % 10], CYA, "Running", "step 3/9: click Donate", "0s"),
      "one frame per repaint, and no second spinner fighting over the row",
    );

    status.stop("Completed");
  } finally {
    t.restore();
  }
});
