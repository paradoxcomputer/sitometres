// Where the crawl's JSON goes, and the parts of the table only a bad run prints.
//
// Nothing had ever executed `writeReport` or `defaultReportPath`. The last line
// a crawl prints is the path `writeReport` handed back — `report written to
// <where>` — so a return value that disagrees with the file it just wrote sends
// the reader to a file that is not there, and the suite would have stayed green.
//
// The print-side branches here are the ones a healthy crawl never takes: the
// reason lines under a FAILED row (which used to repeat the row's own text back
// under itself), the not-reached list, and the collapsed-rows note. The last
// test covers the one branch of the machine artifact that a QML error at open
// takes; every existing test opens cleanly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeReport, defaultReportPath, printReport } from "../dist/report/runreport.js";
import { crawlToMachineReport } from "../dist/report/machine.js";

// Pin the width. terminalWidth() honours $COLUMNS exactly so the layout is
// reproducible without a pty; without this the columns depend on the shell that
// happened to run the suite.
process.env.COLUMNS = "140";

/** A real directory of our own, never the repository. */
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sito-reportwriters-")));

const click = (over = {}) => ({
  label: "Send",
  type: "Button",
  outcome: "worked",
  evidence: [],
  calls: [],
  reachedBy: "open",
  ...over,
});

/** A RunReport as the crawl builds one. */
const report = (over = {}) => ({
  tool: "sitometres",
  version: "0.1.0",
  startedAt: "2026-08-19T10:00:00.000Z",
  durationMs: 4210,
  app: {
    name: "tip_jar",
    type: "ui_qml",
    version: "0.2.0",
    dependencies: ["medusa_core"],
    builtFrom: "/home/dev/tip_jar",
  },
  basecamp: "/opt/logos/LogosBasecampDev",
  userDir: null,
  sandboxHome: null,
  wallet: null,
  fidelity: { fidelity: "verbose", qtLogLines: 12, moduleLogLines: 3, summary: "Qt logging is on", remedy: "" },
  open: { ok: true, nodes: 59, calls: ["medusa_core.getBalance"], errors: [] },
  clicks: [click()],
  setup: null,
  untested: [],
  collapsedRows: 0,
  problems: 0,
  ...over,
});

/** ANSI is emitted only on a TTY; strip it so nothing here depends on that. */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function captured(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(...plain(a.join(" ")).split("\n"));
  try {
    fn();
  } finally {
    console.log = real;
  }
  return lines;
}

/** The cells of every table row, borders dropped. */
const rowsOf = (lines) =>
  lines.filter((l) => l.startsWith("  │")).map((l) => l.split("│").slice(1, -1).map((c) => c.trim()));

// --- where the file goes -----------------------------------------------------

test("writeReport hands back the absolute file it wrote, not the path it was given", () => {
  // This return value is printed as the last line of the run. A caller-supplied
  // --report is relative or unnormalised as often as not, and `report written to
  // out/../reports/run.json` is a path the reader has to resolve themselves.
  const dir = tmp();
  try {
    const where = writeReport(report(), path.join(dir, "out", "..", "reports", "run.json"));
    assert.equal(where, path.join(dir, "reports", "run.json"));
    assert.ok(path.isAbsolute(where));
    assert.ok(fs.existsSync(where), "the path printed to the user is the file that now exists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeReport creates every directory on the way to the file", () => {
  // `.sitometres/` does not exist on a first run, and neither does whatever
  // `--report build/artifacts/ui/run.json` names on CI.
  const dir = tmp();
  try {
    const where = writeReport(report(), path.join(dir, "build", "artifacts", "ui", "run.json"));
    assert.ok(fs.statSync(path.join(dir, "build", "artifacts", "ui")).isDirectory());
    assert.ok(fs.statSync(where).isFile());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the file on disk round-trips as the whole report, and a rerun replaces it", () => {
  // Not a restatement of the literal: it is the assertion that the artifact is
  // the report and not a summary of it. A writer that dropped `newLabels`, or
  // one that appended instead of truncating and left the tail of a longer
  // previous run behind, fails here — the second is why the rerun is in the
  // same test.
  const dir = tmp();
  try {
    const target = path.join(dir, ".sitometres", "tip_jar.json");
    const big = report({
      clicks: [
        click({ label: "Send a 1 LEZ tip", calls: ["medusa_core.startSendTransfer"], evidence: ['the app confirmed: "Sent"'] }),
        click({ label: "About", outcome: "unclear", newLabels: ["Version 0.2.0", "Close"] }),
      ],
      untested: ["Settings", "Sign out"],
      collapsedRows: 223,
      problems: 0,
    });
    writeReport(big, target);

    const small = report({ clicks: [], problems: 1, endedEarly: "the app stopped responding" });
    const where = writeReport(small, target);

    const text = fs.readFileSync(where, "utf8");
    assert.deepEqual(JSON.parse(text), small, "the file is the report, and only the latest one");
    assert.ok(text.endsWith("\n"), "a text artifact ends in a newline or every diff shows a phantom last line");
    assert.ok(
      text.split("\n").length > 20,
      "written indented across lines: this file exists to be diffed against the last build",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the default place -------------------------------------------------------

test("defaultReportPath is the .sitometres/<app>.json the README promises", () => {
  assert.equal(defaultReportPath("tip_jar"), path.join(".sitometres", "tip_jar.json"));
  assert.equal(
    path.isAbsolute(defaultReportPath("tip_jar")),
    false,
    "relative on purpose: the report lands beside the invocation, not in $HOME or in the app's tree",
  );
});

test("a crawl that could not name the app writes run.json, not null.json", () => {
  // `app` is null whenever discovery could not name what it launched — attaching
  // to a running Basecamp is the ordinary case. Interpolating it straight in
  // produced `.sitometres/null.json`, which reads as a bug in the tool.
  assert.equal(defaultReportPath(null), path.join(".sitometres", "run.json"));
  assert.doesNotMatch(defaultReportPath(null), /null|undefined/);
});

test("the default path resolves against the directory the crawl was run from", () => {
  // The two functions together are what the crawl actually calls, and the
  // relative default only means anything once it is resolved.
  const dir = tmp();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const where = writeReport(report(), defaultReportPath("tip_jar"));
    assert.equal(where, path.join(dir, ".sitometres", "tip_jar.json"));
    assert.equal(JSON.parse(fs.readFileSync(where, "utf8")).app.name, "tip_jar");
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the rows only a bad run prints ------------------------------------------

test("a FAILED row spells its reasons out underneath, at most two, in order", () => {
  const lines = captured(() =>
    printReport(
      report({
        clicks: [
          click({
            label: "Send",
            outcome: "failed",
            calls: ["medusa_core.startSendTransfer"],
            evidence: [
              "the app reported: insufficient funds",
              "clicked at 120,48",
              "medusa_core.startSendTransfer failed",
              "error: a third reason nobody reads",
            ],
          }),
        ],
      }),
    ),
  );

  const continuation = rowsOf(lines).filter((r) => r[0] === "" && r[1] === "");
  assert.deepEqual(
    continuation.map((r) => r[2]),
    ["the app reported: insufficient funds", "medusa_core.startSendTransfer failed"],
    "the reason is the point of the run, so it gets its own line rather than being clipped into the column",
  );
  assert.ok(
    !lines.some((l) => l.includes("clicked at 120,48")),
    "evidence that is a trace of what was done, not a reason it failed, stays out of the failure lines",
  );
  assert.ok(!lines.some((l) => l.includes("a third reason")), "two lines under a row, not a transcript");
});

test("a failure whose reason is already in the row is not repeated under it", () => {
  // With no calls to show, the row's own detail cell IS the first piece of
  // evidence; printing it again directly underneath is noise the reader has to
  // re-read to be sure it is the same sentence.
  const lines = captured(() =>
    printReport(
      report({
        clicks: [click({ label: "Pay", outcome: "failed", calls: [], evidence: ["medusa_core.pay failed: gateway refused"] })],
      }),
    ),
  );

  assert.equal(
    lines.filter((l) => l.includes("gateway refused")).length,
    1,
    "the reason appears once, in the row itself",
  );
  assert.deepEqual(rowsOf(lines).filter((r) => r[0] === "" && r[1] === ""), []);
});

test("the not-reached list counts every control and names the first six, quoted", () => {
  const lines = captured(() =>
    printReport(
      report({
        untested: ["Settings", "Sign out", 'Add "test" wallet', "History", "About", "Help", "Rewards", "Delegate"],
      }),
    ),
  );

  assert.ok(
    lines.some((l) => l.includes("8 not reached")),
    "the count is every control that was never reached, not the six that fit",
  );
  const tail = lines.find((l) => l.includes("brought them back:"));
  assert.ok(tail, "the not-reached list did not print at all");
  assert.equal(
    tail.slice(tail.indexOf("back:") + "back:".length).trim(),
    '"Settings", "Sign out", "Add \\"test\\" wallet", "History", "About", "Help"',
    "quoted, because a bare `Sign out` in a comma-separated list reads as two controls",
  );
  assert.ok(!lines.some((l) => l.includes("Rewards") || l.includes("Delegate")), "only six are listed");
});

test("the collapsed-rows note reports how many rows were folded away", () => {
  const lines = captured(() => printReport(report({ collapsedRows: 223 })));
  assert.ok(
    lines.some((l) => l.includes("223 repeated list row(s) skipped — same control, different data.")),
    "clicking 265 zone ids proves nothing that clicking two does not, but the reader must be told it happened",
  );

  const none = captured(() => printReport(report({ collapsedRows: 0 })));
  assert.ok(!none.some((l) => l.includes("repeated list row")), "a crawl that folded nothing says nothing");
});

// --- the machine artifact's other open failure -------------------------------

test("a QML error while opening is a QML error in the artifact, not a failed call", () => {
  // Both kinds of open problem land in one list, and routing an error through
  // the check described as "no failed backend calls" produced a `callsSucceed`
  // check that could never contain a call. Every other test opens cleanly, so
  // the errors side of that list had never been built.
  const m = crawlToMachineReport({
    version: "0.1.0",
    app: "tip_jar",
    basecamp: "/opt/logos/LogosBasecampDev",
    fidelity: { fidelity: "verbose", qtLogLines: 12, moduleLogLines: 3, summary: "", remedy: "" },
    durationMs: 4210,
    open: { ok: true, errors: ['qml: TypeError: Cannot read property "balance" of null'] },
    openProblems: ["medusa_core.init failed while opening"],
    clicks: [{ label: "Send", outcome: "worked", evidence: ["the app confirmed"], calls: [] }],
  });

  const open = m.steps.find((s) => s.action === "open");
  assert.deepEqual(
    open.checks.map((c) => [c.kind, c.description, c.detail]),
    [
      ["noErrors", "no new QML errors while opening", 'qml: TypeError: Cannot read property "balance" of null'],
      ["callsSucceed", "no failed backend calls while opening", "medusa_core.init failed while opening"],
    ],
    "the error keeps its own kind and its own text",
  );
  assert.equal(open.verdict, "fail", "open.ok was true: a step carrying failing checks is still a failed step");
  assert.equal(m.verdict, "fail", "and a crawl whose app threw on the way up has not passed");
});
