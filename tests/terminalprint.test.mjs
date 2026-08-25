// The half of the terminal report that runs after the header: the mark per
// step, the checks under it, the counts at the end, and the private helpers
// they all lean on.
//
// None of it had ever been executed by a test, so each of these branches was
// one edit away from being silently wrong, and one of them is a defect the
// source itself names:
//
//   * `ago()` refuses to date a nix build. Nix normalises store timestamps to
//     the epoch, and doing the arithmetic anyway reported a developer's fresh
//     build as "20674 days ago" — a number that is a property of the store and
//     of nothing else.
//   * the step line clamps its padding at one space. Without the clamp a name
//     wider than the column evaluates `" ".repeat(-7)`, which throws, so a long
//     step name would take the run down at the moment it reported.
//   * `visibleLen()` is the reason colour in a step name does not drag the
//     duration column left; measuring the escape codes would misalign it.
//   * the `calls:` line is suppressed when a check already reported the calls,
//     so the same evidence is not printed under the step twice.
//   * `fail()` writes to stderr. `inspect --json` promises stdout carries only
//     the payload, and an error printed on stdout breaks that for whoever is
//     piping it.
//
// Colour is forced on for the whole file. `useColour` is read once at import,
// so isTTY is faked before the import and restored immediately after; with
// colour on the assertions pin the mark AND its colour, which together are how
// a verdict reads on screen. Nothing here needs a Basecamp: every input is a
// plain StepResult/RunResult/Check literal, which is what the runner hands
// these functions anyway.
import test from "node:test";
import assert from "node:assert/strict";

const realIsTTY = process.stdout.isTTY;
const realNoColour = process.env.NO_COLOR;
process.stdout.isTTY = true;
delete process.env.NO_COLOR;
let terminal;
try {
  terminal = await import("../dist/report/terminal.js");
} finally {
  process.stdout.isTTY = realIsTTY;
  if (realNoColour === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = realNoColour;
}
const { printBanner, printHeader, printStep, printSummary, note, warn, fail } = terminal;

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Both streams, one entry per console call, restored however fn ends. */
function capture(fn) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { out, err };
}

/** What a StepResult looks like coming out of the runner. */
const step = (over = {}) => ({
  index: 0,
  name: "click Send",
  action: "click Send",
  verdict: "pass",
  durationMs: 120,
  checks: [],
  callsObserved: [],
  ...over,
});

const check = (over = {}) => ({
  kind: "text",
  description: 'shows "Sent"',
  verdict: "pass",
  ...over,
});

// --- the wordmark ------------------------------------------------------------

test("the banner prints the wordmark, the version it was handed, and nothing on stderr", () => {
  const { out, err } = capture(() => printBanner("0.1.0"));

  assert.deepEqual(out, [
    "",
    `  ${CYAN}┌─┐┬┌┬┐┌─┐┌┬┐┌─┐┌┬┐┬─┐┌─┐┌─┐${RESET}`,
    `  ${CYAN}└─┐│ │ │ ││││├┤  │ ├┬┘├┤ └─┐${RESET}`,
    `  ${CYAN}└─┘┴ ┴ └─┘┴ ┴└─┘ ┴ ┴└─└─┘└─┘${RESET}`,
    `  ${DIM}UI tests for Logos Basecamp apps${RESET}  ${DIM}v0.1.0${RESET}`,
    `  ${DIM}by Paradox Computer${RESET}  ${DIM}·${RESET}  ${DIM}MIT OR Apache-2.0${RESET}`,
    "",
  ]);
  assert.deepEqual(err, [], "the banner is decoration; it must not pollute stderr");

  // The version is the only part of this that varies, and it is what a bug
  // report is read off, so it is interpolated rather than baked in.
  const other = capture(() => printBanner("9.9.9-rc.1"));
  assert.equal(other.out[4], `  ${DIM}UI tests for Logos Basecamp apps${RESET}  ${DIM}v9.9.9-rc.1${RESET}`);
  assert.deepEqual(other.out.slice(1, 4), out.slice(1, 4), "and nothing else moves with it");
});

test("the three wordmark rows are one width, which is the whole reason the box closes", () => {
  const rows = capture(() => printBanner("0.1.0")).out.slice(1, 4).map((l) => strip(l).slice(2));
  assert.deepEqual(rows.map((r) => [...r].length), [28, 28, 28]);
});

// --- one line per step -------------------------------------------------------

test("a step's mark is its verdict, and no two verdicts render alike", () => {
  const line = (verdict) => capture(() => printStep(step({ verdict, durationMs: 120 }))).out[0];

  // 42 columns of name, so the durations form a column: "click Send" is 10.
  assert.equal(line("pass"), `  ${GREEN}PASS${RESET}  click Send${" ".repeat(32)}${DIM}120ms${RESET}`);
  assert.equal(line("fail"), `  ${RED}FAIL${RESET}  click Send${" ".repeat(32)}${DIM}120ms${RESET}`);
  assert.equal(line("inconclusive"), `  ${YELLOW}????${RESET}  click Send${" ".repeat(32)}${DIM}120ms${RESET}`);

  // Four glyphs each and three different colours: INCONCLUSIVE is neither a
  // pass nor a failure and must not be readable as either at a glance.
  assert.equal(new Set(["pass", "fail", "inconclusive"].map(line)).size, 3);
  assert.equal(strip(line("inconclusive")).indexOf("120ms"), 50, "the duration column is fixed");
});

test("colour inside a step name does not drag the duration column left", () => {
  const plain = capture(() => printStep(step({ name: "click Send" }))).out[0];
  const painted = capture(() => printStep(step({ name: `${CYAN}click Send${RESET}` }))).out[0];

  // Measuring `name.length` instead of its visible length would pad by 9 fewer
  // spaces here — one per byte of escape — and every coloured step would sit
  // out of line with every plain one.
  assert.equal(strip(painted), strip(plain));
  assert.equal(strip(painted).indexOf("120ms"), 50);
});

test("a step name wider than the column still prints, and keeps one space before the duration", () => {
  const name = "click Send, then confirm in the dialog that opens";
  assert.ok(name.length > 42, "wide enough that the padding arithmetic goes negative");

  const { out } = capture(() => printStep(step({ name, action: name, durationMs: 90 })));
  assert.equal(out[0], `  ${GREEN}PASS${RESET}  ${name} ${DIM}90ms${RESET}`);
});

test("the action line appears only when it says something the name did not", () => {
  const differs = capture(() => printStep(step({ name: "send a tip", action: "click Send" })));
  assert.deepEqual(differs.out, [
    `  ${GREEN}PASS${RESET}  send a tip${" ".repeat(32)}${DIM}120ms${RESET}`,
    `        ${DIM}click Send${RESET}`,
  ]);

  const same = capture(() => printStep(step({ name: "click Send", action: "click Send" })));
  assert.equal(same.out.length, 1, "a spec that named its step after the action gets one line, not the same line twice");

  const unnamed = capture(() => printStep(step({ name: "click Send", action: "" })));
  assert.equal(unnamed.out.length, 1, "and a step with no action at all prints no empty line for it");
});

test("the calls line is printed by the check when there was one, and by the step otherwise", () => {
  const unasserted = capture(() =>
    printStep(step({ callsObserved: ["tip_jar.sendTip", "wallet_core.balance"] })),
  );
  assert.equal(
    unasserted.out[1],
    `        ${DIM}calls: tip_jar.sendTip, wallet_core.balance${RESET}`,
    "calls nobody asked about are still reported — that is what the tool is for",
  );

  const asserted = capture(() =>
    printStep(step({
      callsObserved: ["tip_jar.sendTip"],
      checks: [check({ kind: "calls", description: "calls tip_jar.sendTip" })],
    })),
  );
  assert.deepEqual(
    asserted.out.map(strip),
    [
      `  PASS  click Send${" ".repeat(32)}120ms`,
      "        + calls tip_jar.sendTip",
    ],
    "the check already said it; saying it again under the check reads as two separate observations",
  );

  const quiet = capture(() => printStep(step({ callsObserved: [] })));
  assert.equal(quiet.out.length, 1, "no calls observed, no calls line");
});

test("a step that blew up prints its error, one line at a time", () => {
  const { out } = capture(() =>
    printStep(step({
      verdict: "fail",
      error: "no control matched \"Send\"\n  3 visible labels: Cancel, Amount, Balance",
    })),
  );
  // One console.log per line, not one containing a newline: everything else on
  // screen is indented eight columns and a raw multi-line string would leave
  // the second line hard against the margin.
  assert.deepEqual(out.slice(1), [
    `        ${RED}no control matched "Send"${RESET}`,
    `        ${RED}  3 visible labels: Cancel, Amount, Balance${RESET}`,
  ]);
});

// --- one line per check ------------------------------------------------------

test("a passing check, a failing one and an inconclusive one are three different lines", () => {
  const { out } = capture(() =>
    printStep(step({
      verdict: "fail",
      checks: [
        check({ verdict: "pass", description: 'shows "Sent"' }),
        check({ kind: "calls", verdict: "fail", description: "calls tip_jar.sendTip" }),
        check({ kind: "noCalls", verdict: "inconclusive", description: "does not call tip_jar.refund" }),
      ],
    })),
  );

  // A passing check is dimmed as well as marked: it is the line you are meant
  // to skip. The other two keep full-brightness descriptions because they are
  // the reason you are reading the report.
  assert.equal(out[1], `        ${GREEN}+${RESET} ${DIM}shows "Sent"${RESET}`);
  assert.equal(out[2], `        ${RED}x${RESET} calls tip_jar.sendTip`);
  assert.equal(out[3], `        ${YELLOW}?${RESET} does not call tip_jar.refund`);
  assert.equal(out.length, 4);
});

test("a check's detail is printed under it, line by line, and never for a passing check", () => {
  const detail = "observed: tip_jar.getBalance\nexpected: tip_jar.sendTip";

  const failed = capture(() =>
    printStep(step({ verdict: "fail", checks: [check({ kind: "calls", verdict: "fail", description: "calls tip_jar.sendTip", detail })] })),
  );
  assert.deepEqual(failed.out.slice(1), [
    `        ${RED}x${RESET} calls tip_jar.sendTip`,
    `          ${DIM}observed: tip_jar.getBalance${RESET}`,
    `          ${DIM}expected: tip_jar.sendTip${RESET}`,
  ], "the evidence is indented two columns further than the check it explains");

  const inconclusive = capture(() =>
    printStep(step({ verdict: "inconclusive", checks: [check({ kind: "noErrors", verdict: "inconclusive", description: "logs no errors", detail: "no Qt logging reached this session" })] })),
  );
  assert.equal(
    inconclusive.out[2],
    `          ${DIM}no Qt logging reached this session${RESET}`,
    "an inconclusive check is the one whose detail matters most: it is the remedy",
  );

  const passed = capture(() => printStep(step({ checks: [check({ verdict: "pass", detail })] })));
  assert.equal(passed.out.length, 2, "a passing check that carried detail prints the mark and stops");
});

// --- the counts at the end ---------------------------------------------------

test("the summary counts every verdict and omits the categories that are empty", () => {
  const run = (verdicts, durationMs) => capture(() =>
    printSummary({ steps: verdicts.map((verdict) => step({ verdict })), verdict: "fail", durationMs }),
  ).out;

  assert.deepEqual(
    run(["pass", "fail", "pass", "inconclusive"], 4210),
    [`\n  ${GREEN}2 passed${RESET}, ${RED}1 failed${RESET}, ${YELLOW}1 inconclusive${RESET} ${DIM}in 4.2s${RESET}\n`],
  );

  assert.deepEqual(
    run(["pass", "pass", "pass"], 300),
    [`\n  ${GREEN}3 passed${RESET} ${DIM}in 300ms${RESET}\n`],
    "a clean run says one thing; ', 0 failed, 0 inconclusive' would make every green run read as a near miss",
  );

  assert.deepEqual(
    run(["inconclusive", "inconclusive"], 1000),
    [`\n  ${GREEN}0 passed${RESET}, ${YELLOW}2 inconclusive${RESET} ${DIM}in 1.0s${RESET}\n`],
    "nothing passed and nothing failed — the count that must never be rounded up to a pass",
  );
});

test("a run with no steps at all still reports its count", () => {
  const { out } = capture(() => printSummary({ steps: [], verdict: "pass", durationMs: 12 }));
  assert.deepEqual(out, [`\n  ${GREEN}0 passed${RESET} ${DIM}in 12ms${RESET}\n`], "a spec whose steps all aborted is not a silent success");
});

test("a duration under a second reads in milliseconds, and over it in seconds to one decimal", () => {
  const stepDur = (durationMs) => strip(capture(() => printStep(step({ durationMs }))).out[0]).slice(50);
  assert.equal(stepDur(0), "0ms");
  assert.equal(stepDur(999), "999ms", "no rounding while the number is still legible as milliseconds");
  assert.equal(stepDur(1000), "1.0s");
  assert.equal(stepDur(1049), "1.0s");
  assert.equal(stepDur(1050), "1.1s");

  // It never goes further than seconds: a step timeout is quoted in seconds
  // everywhere else in the tool, so "61.5s" is comparable and "1m 1s" is not.
  const summary = capture(() => printSummary({ steps: [], verdict: "pass", durationMs: 61_500 })).out[0];
  assert.equal(strip(summary), "\n  0 passed in 61.5s\n");
});

// --- the three one-line notices ----------------------------------------------

test("note, warn and fail are three different marks, and only fail writes to stderr", () => {
  const n = capture(() => note("staging tip_jar into /tmp/sitometres-userdir-abc"));
  assert.deepEqual(n.out, [`  ${BLUE}i${RESET} staging tip_jar into /tmp/sitometres-userdir-abc`]);
  assert.deepEqual(n.err, []);

  const w = capture(() => warn("no setup profile found for tip_jar"));
  assert.deepEqual(w.out, [`  ${YELLOW}!${RESET} no setup profile found for tip_jar`]);
  assert.deepEqual(w.err, []);

  // `inspect --json` promises stdout carries the payload and nothing else, so a
  // failure that went to stdout would land inside whatever is parsing it.
  const f = capture(() => fail("basecamp exited before the inspector came up"));
  assert.deepEqual(f.err, [`  ${RED}x${RESET} basecamp exited before the inspector came up`]);
  assert.deepEqual(f.out, [], "an error must never be written to the stream a caller is parsing");
});

// --- how old is the build under test -----------------------------------------

/** The minimum header; the build line is what these tests are about. */
const header = (source) => ({
  app: "tip_jar",
  appType: "ui_qml",
  dependencies: [],
  basecamp: "/opt/basecamp/LogosBasecamp",
  userDir: "/tmp/sitometres-userdir-abc",
  logSource: "stderr",
  fidelity: {
    fidelity: "verbose",
    qtLogLines: 242,
    moduleLogLines: 11,
    summary: "Qt logging is on — backend calls, QML errors and console output are all observable.",
  },
  headless: true,
  source,
});

/** The value printed against one header key, e.g. field(out, "built"). */
function field(out, key) {
  const line = out.map(strip).find((l) => l.startsWith(`  ${key} `));
  return line === undefined ? null : line.slice(2 + key.length).trim();
}

/** Just the age, out of "<origin> (<form>, <age>)". */
const age = (builtAt) =>
  field(capture(() => printHeader(header({ origin: "/nix/store/abc-tip_jar", form: "dir", builtAt }))).out, "built")
    .replace(/^.*, /, "")
    .replace(/\)$/, "");

test("an epoch-normalised build reads as from the nix store, not as twenty thousand days old", () => {
  // Nix sets every file in the store to 1970-01-01, so the arithmetic below is
  // meaningless for a store path and produced a number that grew by one a day
  // while the build itself was minutes old.
  assert.equal(age(1), "from the nix store");
  assert.equal(age(86_399_999), "from the nix store", "anything inside the first day after the epoch is the store, not a build");
  assert.equal(age(0), "unknown age", "and a timestamp we never learned says so rather than dating the build to 1970");
});

test("build age is coarse on purpose: seconds, then minutes, then hours, then days", () => {
  const now = Date.now();
  assert.equal(age(now), "0s ago");
  assert.equal(age(now - 45_000), "45s ago");
  assert.equal(age(now - 89_000), "89s ago", "seconds hold until a minute and a half");
  assert.equal(age(now - 95_000), "2 min ago");
  assert.equal(age(now - 20 * 60_000), "20 min ago");
  assert.equal(age(now - 89 * 60_000), "89 min ago", "and minutes hold until an hour and a half");
  assert.equal(age(now - 90 * 60_000), "2h ago");
  assert.equal(age(now - 47 * 3_600_000), "47h ago", "hours hold for two days, so yesterday's build is still countable in them");
  assert.equal(age(now - 5 * 86_400_000), "5 days ago");

  // A clock that moved backwards since the build must not print a negative age.
  assert.equal(age(now + 30_000), "0s ago");
});

test("the built line names the version when the manifest had one, and omits it when it did not", () => {
  const withVersion = capture(() =>
    printHeader(header({ origin: "/nix/store/abc-tip_jar/lib/tip_jar", form: "lgx", builtAt: 1, version: "1.2.0" })),
  );
  assert.equal(
    field(withVersion.out, "built"),
    "/nix/store/abc-tip_jar/lib/tip_jar (v1.2.0, lgx, from the nix store)",
    "which copy was tested, in what form, and how old — the whole 'is this my latest build?' question",
  );

  const now = Date.now();
  const without = capture(() =>
    printHeader(header({ origin: "/home/dev/tip_jar/build", form: "dir", builtAt: now - 45_000 })),
  );
  assert.equal(
    field(without.out, "built"),
    "/home/dev/tip_jar/build (dir, 45s ago)",
    "no version, and no stray 'v, ' where one would have gone",
  );

  const none = capture(() => printHeader({ ...header(undefined) }));
  assert.equal(field(none.out, "built"), null, "a caller that could not work out where the build came from claims nothing");
});

// --- the prose the header wraps ----------------------------------------------

test("a remedy is wrapped at seventy-four columns without breaking a word", () => {
  // Worded so that one line lands on column 74 exactly. That line is the only
  // thing separating a width of 74 from a width of 73: with the comparison one
  // out, it fits nothing that reaches the margin and the text goes ragged.
  const remedy =
    "Set QT_FORCE_STDERR_LOGGING=1 in the environment of the process you attached to, " +
    "or drop --attach so sitometres will start Basecamp itself and set the variable for you.";
  const { out } = capture(() =>
    printHeader({
      ...header(undefined),
      fidelity: { fidelity: "quiet", qtLogLines: 0, moduleLogLines: 5, summary: "No Qt logging is reaching this session.", remedy },
    }),
  );

  // The remedy is the only wrapped prose on screen; header fields are indented
  // two columns and these four.
  const lines = out.filter((l) => l.startsWith(`    ${DIM}`)).map((l) => strip(l).slice(4));
  assert.ok(lines.length >= 3, `long enough to wrap more than once; got ${lines.length}`);
  assert.equal(lines.join(" "), remedy, "every word survives, in order, and none is split across lines");
  for (const l of lines) assert.ok(l.length <= 74, `"${l}" is ${l.length} columns, past the 74 the terminal is assumed to have`);
  assert.ok(lines.some((l) => l.length === 74), "a word that reaches the margin exactly is kept on the line");
  for (let i = 0; i < lines.length - 1; i++) {
    const next = lines[i + 1].split(" ")[0];
    assert.ok(
      lines[i].length + next.length + 1 > 74,
      `line ${i + 1} broke early: "${next}" would still have fitted, so the text is ragged for no reason`,
    );
  }
});
