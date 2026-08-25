// The artifact CI actually reads.
//
// A JUnit file that no parser accepts is reported by every publisher as "no
// test results" — indistinguishable from not having run at all, which is the
// precise failure this output was added to prevent.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { toJUnit, toJson, crawlToMachineReport, esc } from "../dist/report/machine.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

const report = (over = {}) => ({
  tool: "sitometres",
  version: "0.1.0",
  app: "my_app",
  basecamp: "/x",
  fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "s", remedy: "r" },
  verdict: "fail",
  durationMs: 10,
  steps: [],
  ...over,
});

const step = (over = {}) => ({
  index: 0,
  name: "click Send",
  action: "click",
  verdict: "fail",
  durationMs: 1,
  checks: [],
  callsObserved: [],
  ...over,
});

/** Parse with a real XML parser rather than trusting the string. */
function parses(xml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-xml-"));
  const file = path.join(dir, "j.xml");
  fs.writeFileSync(file, xml);
  try {
    execFileSync("python3", ["-c", "import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1])", file], {
      stdio: "pipe",
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `${e.stderr ?? e}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ANSI colour in an app's log does not break the XML", () => {
  const xml = toJUnit(
    report({
      steps: [
        step({
          checks: [
            {
              kind: "noErrors",
              description: "no new QML errors",
              verdict: "fail",
              detail: `the app reported: ${ESC}[31mERROR${ESC}[0m failed${BEL}`,
            },
          ],
        }),
      ],
    }),
  );
  assert.ok(!xml.includes(ESC), "escape bytes are illegal in XML 1.0 and have no entity form");
  assert.ok(!xml.includes(BEL));
  const r = parses(xml);
  assert.ok(r.ok, `JUnit must be well-formed: ${r.why}`);
  assert.match(xml, /ERROR failed/, "and the message must stay readable once the colour is gone");
});

test("every other C0 control byte is stripped too", () => {
  const xml = toJUnit(report({ steps: [step({ error: `died${NUL}here${BEL}` })] }));
  const r = parses(xml);
  assert.ok(r.ok, `JUnit must be well-formed: ${r.why}`);
  assert.match(xml, /diedhere/);
});

test("the five XML entities are still escaped", () => {
  assert.equal(esc('a & b < c > d "e"'), "a &amp; b &lt; c &gt; d &quot;e&quot;");
});

test("a failure always states a reason", () => {
  // `detail` is "" when no failing check carried one, and ?? does not catch
  // an empty string — this used to emit <failure message="">.
  const xml = toJUnit(
    report({ steps: [step({ checks: [{ kind: "text", description: "", verdict: "fail" }] })] }),
  );
  assert.ok(parses(xml).ok);
  assert.doesNotMatch(xml, /<failure message=""/, "a failure that does not say what failed is not a report");
  assert.match(xml, /no further detail/);
});

test("a crawl's JUnit agrees with the crawl's own outcome vocabulary", () => {
  const m = crawlToMachineReport({
    version: "0.1.0",
    app: "my_app",
    basecamp: "/x",
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 100,
    open: { ok: true, errors: [] },
    clicks: [
      { label: "Save", outcome: "worked", evidence: ["the app confirmed"], calls: [] },
      { label: "Poke", outcome: "failed", evidence: ["boom"], calls: [] },
      { label: "Inert", outcome: "nothing", evidence: [], calls: [] },
    ],
  });
  assert.equal(m.verdict, "fail", "a failed control must fail the report");
  const xml = toJUnit(m);
  assert.ok(parses(xml).ok);
  assert.match(xml, /failures="1"/);
  // `worked` and `nothing` are both CONCLUSIVE — the app confirmed, or nothing
  // happened. Only `unclear` is "the tool could not tell". Reporting `ran` and
  // `nothing` as skipped is what made --strict fail every healthy crawl.
  assert.match(xml, /skipped="0"/);
  assert.equal(JSON.parse(toJson(m)).verdict, "fail", "JSON and JUnit must agree");

  const withUnclear = crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x",
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 100, open: { ok: true, errors: [] },
    clicks: [{ label: "Poke", outcome: "unclear", evidence: [], calls: [] }],
  });
  assert.match(toJUnit(withUnclear), /skipped="1"/, "unclear is the one that is genuinely inconclusive");
});

// --- the artifact must agree with the exit code ------------------------------

const crawl = (over = {}) =>
  crawlToMachineReport({
    version: "0.1.0",
    app: "my_app",
    basecamp: "/x",
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 100,
    open: { ok: true, errors: [] },
    clicks: [{ label: "Save", outcome: "worked", evidence: ["confirmed"], calls: [] }],
    ...over,
  });

test("an app that died mid-crawl is a failure in the artifact, not just in the exit code", () => {
  const m = crawl({ endedEarly: "socket closed" });
  assert.equal(m.verdict, "fail", "the process exits 1; the JUnit said failures=0");
  const xml = toJUnit(m);
  assert.ok(parses(xml).ok);
  assert.match(xml, /failures="1"/);
  assert.match(xml, /socket closed/);
});

test("a setup profile that did not complete is a failure in the artifact", () => {
  const m = crawl({ setupFailed: "step 2 never came true" });
  assert.equal(m.verdict, "fail");
  assert.match(toJUnit(m), /setup profile/);
});

test("step indices stay unique when setup and early-end steps are added", () => {
  const m = crawl({ setupFailed: "x", endedEarly: "y" });
  const idx = m.steps.map((s) => s.index);
  assert.equal(new Set(idx).size, idx.length, `indices must not collide: ${idx}`);
});

test("a clean crawl is unchanged", () => {
  const m = crawl();
  assert.equal(m.verdict, "pass");
  assert.match(toJUnit(m), /failures="0"/);
});

// --strict's two conditions were computed inside smoke() and passed nowhere, so
// a completed crawl could exit 1 while its own artifact said verdict "pass" and
// failures="0". Reproduced before this fix: a verbose crawl whose controls are
// all inert exits 1 under --strict, because it proved nothing, and every graded
// step passes — `nothing` is a conclusive observation. A maintainer saw a red
// job with an all-green report attached.
test("a strict crawl that proved nothing fails in the artifact, not only in the exit code", () => {
  const inert = crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x",
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 100, open: { ok: true, errors: [] },
    clicks: [
      { label: "Inert", outcome: "nothing", evidence: [], calls: [] },
      { label: "Also inert", outcome: "nothing", evidence: [], calls: [] },
    ],
    strictGate: { provedNothing: true, evidenceUnreadable: false },
  });
  assert.equal(inert.verdict, "fail");
  const xml = toJUnit(inert);
  assert.ok(parses(xml).ok);
  assert.match(xml, /failures="1"/, "the artifact used to say failures=\"0\" for this exact run");
  assert.match(xml, /the crawl proved something/);
});

test("a strict crawl that could not read evidence fails in the artifact too", () => {
  const quiet = crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x",
    fidelity: { fidelity: "quiet", qtLogLines: 0, moduleLogLines: 9, summary: "no Qt logging is reaching this session", remedy: "r" },
    durationMs: 100, open: { ok: true, errors: [] },
    // `worked` under quiet fidelity: on-screen text confirmed it, so nothing is
    // unclear and every step passes, while --strict still exits 1.
    clicks: [{ label: "Save", outcome: "worked", evidence: ["the app confirmed"], calls: [] }],
    strictGate: { provedNothing: false, evidenceUnreadable: true },
  });
  assert.equal(quiet.verdict, "fail");
  assert.match(toJUnit(quiet), /no Qt logging is reaching this session/, "and it says which condition tripped");
});

test("without --strict those conditions change nothing", () => {
  // The gate is only passed when --strict is in force, because only then does
  // it affect the exit code — and the requirement is that the artifact express
  // what the exit code counts, not more.
  const m = crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x",
    fidelity: { fidelity: "quiet", qtLogLines: 0, moduleLogLines: 9, summary: "", remedy: "" },
    durationMs: 100, open: { ok: true, errors: [] },
    clicks: [{ label: "Inert", outcome: "nothing", evidence: [], calls: [] }],
  });
  assert.equal(m.verdict, "pass", "a non-strict crawl of inert controls exits 0, and must report 0");
  assert.match(toJUnit(m), /failures="0"/);
});

// An `unclear` click carries no evidence and no calls by construction — the
// screen changed and nothing said whether it worked — so the one field a reader
// could use was empty for exactly the outcome that most needs explaining, while
// the crawl had the changed labels in hand and threw them away.
test("an unclear click says what appeared, rather than nothing at all", () => {
  const m = crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x",
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 100, open: { ok: true, errors: [] },
    clicks: [{ label: "Amount", outcome: "unclear", evidence: [], calls: [], newLabels: ["Enter an amount in LOG"] }],
  });
  assert.equal(m.steps.at(-1).checks[0].detail, "now shows: Enter an amount in LOG");
});

test("real evidence still wins over the labels", () => {
  const m = crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x",
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 100, open: { ok: true, errors: [] },
    clicks: [{ label: "Send", outcome: "ran", evidence: ["called mod.send"], calls: ["mod.send"], newLabels: ["Sending…"] }],
  });
  assert.equal(m.steps.at(-1).checks[0].detail, "called mod.send");
});
