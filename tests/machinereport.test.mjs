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

import { toJUnit, toJson, crawlToMachineReport, buildSourceOf, esc } from "../dist/report/machine.js";

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

// --- which build was graded --------------------------------------------------
//
// `app` is a name and `basecamp` is a path, so neither says WHICH BUILD the
// verdict is about — and a repo routinely holds the same app twice, an
// unpacked plugins/<name>/ beside a freshly built result/*.lgx. The run has
// always known which one it staged; it used to spend that on the terminal
// header and drop it before writing the artifact CI reads.
test("the artifact names the build the verdict is about", () => {
  const m = crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x",
    source: { origin: "result/my_app.lgx", form: "lgx", builtAt: 1_700_000_000_000, version: "2.3.4" },
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 100, open: { ok: true, errors: [] },
    clicks: [{ label: "Save", outcome: "worked", evidence: ["confirmed"], calls: [] }],
  });
  assert.deepEqual(JSON.parse(toJson(m)).source, {
    origin: "result/my_app.lgx",
    form: "lgx",
    builtAt: 1_700_000_000_000,
    version: "2.3.4",
  });

  const xml = toJUnit(m);
  assert.ok(parses(xml).ok, "adding <properties> must not cost us the parser");
  assert.match(xml, /<property name="sitometres.origin" value="result\/my_app.lgx"\/>/);
  assert.match(xml, /<property name="sitometres.form" value="lgx"\/>/);
  assert.match(xml, /<property name="sitometres.builtAt" value="1700000000000"\/>/, "the epoch ms the JSON carries, not a date nothing measured");
  assert.match(xml, /<property name="sitometres.version" value="2.3.4"\/>/, "the app version, not the tool's");
  // The JUnit schema orders <properties> before the first <testcase>; appended
  // after them it is a file some parsers reject, which is the failure this
  // whole output exists to avoid.
  assert.ok(xml.indexOf("<properties>") < xml.indexOf("<testcase"), xml);
});

test("attach mode has no build to name, and says nothing rather than guessing", () => {
  // --attach drives a Basecamp somebody else started and stages nothing, so
  // there is no build it could name. The field is optional for that case, and
  // the XML must come out exactly as it did before it existed.
  const attached = crawl();
  assert.equal("source" in attached, false);
  const xml = toJUnit(attached);
  assert.ok(parses(xml).ok);
  assert.doesNotMatch(xml, /<propert/);
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

test("buildSourceOf is the one description of a build, so no emit site can invent its own", () => {
  // run and smoke each spelled these four fields out by hand, and smoke's two
  // failure paths were written without them - so the artifact kept from a RED
  // job, the one a reader actually opens, could not say which build failed.
  const app = {
    origin: "plugins/demo_ui",
    form: "dir",
    builtAt: 1700000000000,
    manifest: { name: "demo_ui", version: "9.9.9" },
  };
  assert.deepEqual(buildSourceOf(app), {
    origin: "plugins/demo_ui",
    form: "dir",
    builtAt: 1700000000000,
    version: "9.9.9",
  });

  // A manifest with no version omits the key rather than carrying undefined,
  // so the JSON does not claim a version nothing declared.
  const noVersion = buildSourceOf({ ...app, manifest: { name: "demo_ui" } });
  assert.equal("version" in noVersion, false);

  // Attach mode staged nothing, and undefined is what the optional field wants.
  assert.equal(buildSourceOf(null), undefined);
  assert.equal(buildSourceOf(undefined), undefined);
});

test("a run that passed keeps its artifacts even if something reached esc that was not a string", () => {
  // The failure this guards is the one this file exists to prevent, arriving by
  // a new route: a non-string `version` off a manifest reached esc() through
  // buildSourceOf, `s.replace is not a function` escaped toJUnit, and the run's
  // JUnit was never written while its already-correct JSON was overwritten by a
  // stillborn report. A PASSING run, reported as a failure to start.
  assert.equal(esc(2), "2", "the last gate before the only file CI reads coerces rather than throws");
  assert.equal(esc("a & b"), "a &amp; b", "and still escapes what it is actually for");

  // buildSourceOf states the type it publishes, so the artifact shape cannot be
  // broken from a distance by whatever a manifest happens to hold.
  const numeric = buildSourceOf({
    origin: "plugins/demo_ui",
    form: "dir",
    builtAt: 1700000000000,
    manifest: { name: "demo_ui", version: 2 },
  });
  assert.equal("version" in numeric, false, "a version that is not a string is not published as one");
  assert.equal(numeric.origin, "plugins/demo_ui", "the rest of the build identity survives it");

  // End to end: the document still parses, and still names the build.
  const xml = toJUnit(report({ source: numeric, verdict: "pass" }));
  assert.equal(parses(xml).ok, true, parses(xml).why ?? "");
  assert.match(xml, /<property name="sitometres.origin" value="plugins\/demo_ui"\/>/);
  assert.equal(/name="sitometres.version"/.test(xml), false, "and claims no version, rather than a broken one");
});

// --- staged artifacts, and which app each step ran in ---------------------------

const DIGEST = "9c1e04b7aa3f5d12" + "ab".repeat(24);
const stagedRecords = [
  {
    name: "tip_jar", version: "0.2.1", slot: "plugins", artifact: "/w/tip_jar/result/tip_jar.lgx", form: "lgx",
    provenance: "local", builtAt: 1_700_000_000_000,
    hashes: [{ kind: "view", path: "qml/Main.qml", sha256: "3f9a1c0e5b7d2a44" + "cd".repeat(24) }],
  },
  {
    name: "medusa_core", version: "0.5.0", slot: "modules", artifact: "/w/medusa/module/result/medusa_core.lgx", form: "lgx",
    provenance: "local", builtAt: null,
    hashes: [{ kind: "library", path: "medusa_core_plugin.so", sha256: DIGEST }],
  },
];

test("the JSON carries every staged record, the full digest, and null for an unknown build time", () => {
  const json = JSON.parse(toJson(report({ staged: stagedRecords })));
  assert.equal(json.staged.length, 2);
  assert.equal(json.staged[1].hashes[0].sha256, DIGEST, "all 64 hex digits, not the 16 the terminal shows");
  assert.match(json.staged[1].hashes[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(json.staged[1].builtAt, null, "unknown is null, never 0 or 1970");
  assert.deepEqual(Object.keys(json.staged[0]).sort(), ["artifact", "builtAt", "form", "hashes", "name", "provenance", "slot", "version"]);
});

test("the JUnit suite carries the staged records as properties, and still parses", () => {
  const xml = toJUnit(report({ staged: stagedRecords, steps: [step({ verdict: "pass" })] }));
  assert.ok(parses(xml).ok, parses(xml).why);
  assert.match(xml, /<property name="sitometres\.staged\.medusa_core\.version" value="0\.5\.0"\/>/);
  assert.match(xml, /<property name="sitometres\.staged\.medusa_core\.artifact" value="\/w\/medusa\/module\/result\/medusa_core\.lgx"\/>/);
  assert.match(xml, /<property name="sitometres\.staged\.medusa_core\.provenance" value="local"\/>/);
  assert.match(xml, /<property name="sitometres\.staged\.medusa_core\.builtAt" value="unknown"\/>/);
  assert.match(xml, new RegExp(`<property name="sitometres\\.staged\\.medusa_core\\.sha256\\.medusa_core_plugin\\.so" value="${DIGEST}"/>`));
  assert.match(xml, /<property name="sitometres\.staged\.tip_jar\.builtAt" value="1700000000000"\/>/);
  assert.match(xml, /<property name="sitometres\.staged\.tip_jar\.sha256\.qml\/Main\.qml" value="3f9a1c0e5b7d2a44/);
  assert.equal(xml.match(/<properties>/g).length, 1, "one suite-level block");
});

test("a single-app report's testcases are byte-identical to what they were", () => {
  const steps = [
    step({ name: "opens", verdict: "pass", app: "tip_jar" }),
    step({ name: "breaks", verdict: "fail", app: "tip_jar", checks: [{ kind: "text", description: "sees x", verdict: "fail" }] }),
    step({ name: "unknown", verdict: "inconclusive", app: "tip_jar", checks: [{ kind: "calls", description: "calls y", verdict: "inconclusive" }] }),
  ];
  const cases = (xml) => xml.slice(xml.indexOf("<testcase"));
  const before = toJUnit(report({ steps: steps.map(({ app, ...rest }) => rest) }));
  const after = toJUnit(report({ steps, staged: stagedRecords }));
  assert.equal(cases(after), cases(before), "the app a step ran in is not written for a single-app spec");
  assert.doesNotMatch(cases(after), /sitometres\.app/);
});

test("a multi-app report puts sitometres.app on each testcase, and still parses", () => {
  const steps = [
    step({ name: "tip jar opens", verdict: "pass", app: "tip_jar" }),
    step({ name: "approve", verdict: "fail", app: "medusa_ui", checks: [{ kind: "state", description: 'state "x" in medusa_ui', verdict: "fail", in: "medusa_ui" }] }),
    step({ name: "not attempted", verdict: "inconclusive", checks: [{ kind: "state", description: "this step ran", verdict: "inconclusive" }] }),
  ];
  const xml = toJUnit(report({ steps, multiApp: true }));
  assert.ok(parses(xml).ok, parses(xml).why);
  const tcs = xml.split("<testcase").slice(1);
  assert.match(tcs[0], /<property name="sitometres\.app" value="tip_jar"\/>/);
  assert.match(tcs[1], /<property name="sitometres\.app" value="medusa_ui"\/>/);
  assert.ok(tcs[1].indexOf("<properties>") < tcs[1].indexOf("<failure"), "properties come first in a testcase");
  assert.doesNotMatch(tcs[2], /sitometres\.app/, "a step that never ran was in no app");
  const json = JSON.parse(toJson(report({ steps, multiApp: true })));
  assert.deepEqual(json.steps.map((s) => s.app), ["tip_jar", "medusa_ui", undefined]);
  assert.equal(json.steps[1].checks[0].in, "medusa_ui");
});

test("a crawl's artifact carries what was staged, and attach mode carries nothing", () => {
  const staged = crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x", staged: stagedRecords,
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 1, open: { ok: true, errors: [] }, clicks: [],
  });
  assert.equal(staged.staged.length, 2);
  const none = crawlToMachineReport({
    version: "0.1.0", app: null, basecamp: "(attached)", staged: [],
    fidelity: { fidelity: "quiet", qtLogLines: 0, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 1, open: { ok: true, errors: [] }, clicks: [],
  });
  assert.equal("staged" in none, false, "no hash is written when nothing was staged");
});
