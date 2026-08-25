// The documentation has to describe the tool that exists.
//
// The README's headline sample run was written by hand, and every part of it
// that mattered was output no code path produces: a per-click `PASS` mark the
// crawl never emits (PASS is the OPEN line, and clicks are graded FAIL/OK/RAN/
// NONE/????), an evidence line reading `calls: …` where `classifyOutcome`
// writes `called …`, and a closing summary — "N control(s) did something, 0
// inert, 0 problem(s)" — that appears nowhere in src/ or dist/ at all. Someone
// reading it was being told what a run looks like by a page that had never
// seen one.
//
// The reference text had the same disease in the other direction. `--quiet`
// and `--variant` were accepted by the parser and documented nowhere, so the
// only way to find them was to read cli.ts. `--strict` — the one mechanism
// that stops a run which proved nothing from passing CI — was in neither
// README.md nor SKILL.md. And `--headed` sat under a heading reading "COMMON
// OPTIONS — every command", so a reader typed
// `sitometres doctor --basecamp X --headed` out of the tool's own reference
// and got a hard error.
//
// So: nothing here reads the docs for tone. Every assertion re-derives the
// claim from dist/ or from the arity tables in src/cli.ts and holds the prose
// to it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { parseArgs, ArgError, KNOWN_VERBS } from "../dist/cli.js";
import { classifyOutcome, describeOutcome } from "../dist/runner/outcome.js";
import { printReport } from "../dist/report/runreport.js";
import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine } from "../dist/logs/classify.js";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const README = read("README.md");
const SKILL = read("SKILL.md");
const CLI_SRC = read("src/cli.ts");
const SMOKE_SRC = read("src/commands/smoke.ts");

/**
 * smoke.ts with its comments removed, for claims about what the crawl PRINTS.
 *
 * Crude on purpose — it drops `//` lines and block comments, which is enough to
 * stop a sentence surviving in prose above the code that no longer emits it.
 */
const CODE_LINES = SMOKE_SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"));

/** The USAGE template literal — the text `--help` prints. */
const USAGE = (() => {
  const start = CLI_SRC.indexOf("const USAGE = `");
  assert.notEqual(start, -1, "USAGE moved; this file reads it as source text, as diagnostics.test.mjs does");
  const from = CLI_SRC.indexOf("`", start) + 1;
  const to = CLI_SRC.indexOf("\n`;", from);
  assert.ok(to > from, "could not find the end of the USAGE literal");
  return CLI_SRC.slice(from, to);
})();

/** The ```console block at the top of the README: the headline sample run. */
const SAMPLE = (() => {
  const m = README.match(/```console\n([\s\S]*?)\n```/);
  assert.ok(m, "the README no longer shows a sample run");
  return m[1].split("\n");
})();

/** ANSI is emitted only on a TTY, but strip it so the test does not depend on that. */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Run a printer and collect what it wrote, line by line. */
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

/** A RunReport with nothing in it but the fields printReport reads. */
const report = (clicks) => ({
  tool: "sitometres",
  version: "0.1.0",
  startedAt: "",
  durationMs: 0,
  app: { name: "YOUR_APP_NAME", type: "ui_qml", version: "0.1.0", dependencies: [], builtFrom: "" },
  basecamp: "",
  userDir: null,
  wallet: null,
  fidelity: { fidelity: "live", summary: "" },
  open: { ok: true, nodes: 59, calls: [], errors: [] },
  clicks,
  setup: null,
  untested: [],
  collapsedRows: 0,
  problems: 0,
});

const click = (over) => ({
  label: "x",
  type: "Button",
  outcome: "nothing",
  evidence: [],
  calls: [],
  newLabels: [],
  reachedBy: "open",
  ...over,
});

// --- the sample run ----------------------------------------------------------

/**
 * The mark the crawl prints for each outcome, read out of smoke.ts.
 *
 * Derived rather than listed, so renaming a mark in the code and leaving the
 * README alone fails here instead of shipping.
 */
const MARKS = (() => {
  const block = SMOKE_SRC.slice(SMOKE_SRC.indexOf("const mark ="));
  const body = block.slice(0, block.indexOf(";"));
  const byOutcome = new Map();
  for (const m of body.matchAll(/report\.outcome === "(\w+)"\s*\?\s*`\$\{\w+\}([^$`]+)\$\{RST\}`/g)) {
    byOutcome.set(m[1], m[2].trim());
  }
  // The last arm has no condition: it catches every outcome not named above.
  const fallback = body.match(/:\s*`\$\{\w+\}([^$`]+)\$\{RST\}`;?\s*$/);
  assert.ok(fallback, "the mark expression no longer ends in a fallback arm");
  for (const o of ["failed", "worked", "ran", "unclear", "nothing"]) {
    if (!byOutcome.has(o)) byOutcome.set(o, fallback[1].trim());
  }
  return byOutcome;
})();

/** Every `MARK  click "label" words` line in the sample. */
const CLICK_LINES = SAMPLE.map((l) => l.match(/^ {2}(\S+) {2,}click ("(?:[^"\\]|\\.)*") (.+)$/))
  .filter(Boolean)
  .map((m) => ({ mark: m[1], label: JSON.parse(m[2]), words: m[3] }));

test("every per-click mark in the sample run is one the crawl can emit", () => {
  assert.equal(MARKS.size, 5, "one mark per Outcome, or the extraction above has drifted");
  const legal = new Set(MARKS.values());

  // Not vacuous: the sample has to show a crawl for the check to mean anything.
  assert.ok(CLICK_LINES.length >= 4, `the sample shows ${CLICK_LINES.length} clicks; a sample of none checks none`);
  const used = new Set(CLICK_LINES.map((c) => c.mark));
  assert.ok(used.size >= 1, "and at least one of them carries a real mark");
  for (const mark of used) {
    assert.ok(legal.has(mark), `${mark} is not a mark smoke.ts prints: ${[...legal].join(" ")}`);
  }

  // The specific fabrication. PASS is real, but it grades the OPEN step; a
  // click is never PASS, so a sample showing one was showing invented output.
  assert.ok(!used.has("PASS"), "PASS is the open-step mark, never a click's");
  assert.match(SMOKE_SRC, /"PASS"[^\n]*\}\s*open \$\{appName\}/, "and PASS really is the open line");
  assert.ok(
    SAMPLE.some((l) => /^ {2}PASS {2,}open /.test(l)),
    "the sample still shows the open line it belongs to",
  );
});

test("the words beside each mark are describeOutcome's, not a paraphrase", () => {
  const outcomeOf = new Map([...MARKS].map(([outcome, mark]) => [mark, outcome]));
  for (const c of CLICK_LINES) {
    const outcome = outcomeOf.get(c.mark);
    assert.ok(outcome, `no outcome maps to ${c.mark}`);
    assert.equal(
      c.words,
      describeOutcome(outcome),
      `click ${JSON.stringify(c.label)}: the console prints describeOutcome(${JSON.stringify(outcome)})`,
    );
  }
  // "ran (unconfirmed)" is the one that carries the project's whole argument —
  // a dispatched call is not a successful one — so the sample must not have
  // quietly shortened it to "ran".
  assert.ok(
    CLICK_LINES.some((c) => c.words === describeOutcome("ran") && c.words !== "ran"),
    "the sample must show a `ran` click, hedge and all",
  );
});

test("the grades the README documents are exactly the ones the report table prints", () => {
  // Rendered rather than listed: one click per Outcome, then read the Outcome
  // column back. A grade the docs name that the table never prints — or one it
  // prints that the docs never explain — fails here.
  const outcomes = ["worked", "ran", "failed", "unclear", "nothing"];
  const rows = captured(() => printReport(report(outcomes.map((o, i) => click({ label: `c${i}`, outcome: o })))))
    .filter((l) => /^ {2}│ c\d /.test(l))
    .map((l) => l.split("│")[2].trim());
  assert.equal(rows.length, outcomes.length);

  // The grades table is the one headed "| | meaning |", not the several other
  // markdown tables in the file.
  const table = README.slice(README.indexOf("| | meaning |"));
  const documented = [...table.slice(0, table.indexOf("\n\n")).matchAll(/^\| `([^`]+)` \| /gm)].map((m) => m[1]);
  assert.deepEqual(
    documented,
    rows,
    "the grade table under \"What a crawl can and cannot tell you\" must list what the tool prints, in order",
  );
});

test("the report table and the counts under it are exactly what printReport writes", () => {
  // This is where the invented summary lived: "N control(s) did something, 0
  // inert, 0 problem(s)" was in the README and in no source file. Rather than
  // grep for the wording, render the sample's own four clicks and diff.
  const first = SAMPLE.findIndex((l) => l.startsWith("  Report — "));
  assert.notEqual(first, -1, "the sample no longer shows the report table");
  const last = SAMPLE.findIndex((l) => l.startsWith("  report written to "));
  assert.ok(last > first, "the sample no longer ends with the report path");
  const shown = SAMPLE.slice(first, last - 1);

  // The width the sample was captured at; the layout is a function of it.
  const before = process.env.COLUMNS;
  process.env.COLUMNS = "88";
  let printed;
  try {
    printed = captured(() =>
      printReport(
        report([
          click({ label: "Refresh", outcome: "ran", calls: ["YOUR_MODULE.listItems"] }),
          click({
            label: "Connect",
            outcome: "worked",
            // Two calls, so the cell clips — the sample shows the ellipsis.
            calls: ["YOUR_MODULE.connectRequest", "YOUR_MODULE.actionApproved"],
          }),
          click({ label: "Amount", type: "TextField", outcome: "unclear", newLabels: ["Enter an amount"] }),
          click({ label: "About", outcome: "nothing" }),
        ]),
      ),
    );
  } finally {
    if (before === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = before;
  }

  assert.deepEqual(printed.filter((l) => l !== ""), shown.filter((l) => l !== ""));
  assert.ok(
    printed.includes("  1 worked  1 ran  0 failed  1 unclear  1 no change seen"),
    "and the counts line is the printer's, not prose",
  );
});

test("an evidence line naming backend calls is written the way classifyOutcome writes it", () => {
  // The line said `calls: <module>.<method>`. Nothing emits that; the report
  // function emits `called …`, singular verb, no colon.
  const buffer = new LogBuffer();
  buffer.append('LogosAPIClient: invoking remote method "YOUR_MODULE" "listItems" args_count: 0', "stdout");
  const real = classifyOutcome({
    window: buffer.slice(0).map(parseLine),
    newLabels: [],
    appName: "YOUR_APP_NAME",
    logsUsable: true,
  });
  assert.equal(real.outcome, "ran");
  assert.deepEqual(real.evidence, ["called YOUR_MODULE.listItems"]);

  const evidence = SAMPLE.filter((l) => /^ {8}called /.test(l)).map((l) => l.trim());
  assert.ok(evidence.length >= 2, "the sample must show call evidence, or this proves nothing");
  assert.ok(
    evidence.includes(real.evidence[0]),
    `the sample's call evidence must be a line classifyOutcome produces: ${evidence.join(" / ")}`,
  );
  for (const line of evidence) {
    assert.match(line, /^called \S+(, \S+)*$/, `"${line}" is not the shape classifyOutcome writes`);
  }
});

test("the crawl's advisory lines are quoted from smoke.ts, not paraphrased", () => {
  // These are the sentences that stop `ran` being read as success and stop an
  // inert control being read as a working one. A paraphrase in the README is a
  // second, unmaintained copy of the tool's most load-bearing caveat.
  for (const advice of [
    "the call was made; whether it succeeded is not visible from the log",
    // Reworded deliberately: "no effect ... is the handler wired up?" asserted a CAUSE the
    // evidence does not support, and sent readers debugging working controls. These two
    // state the observation and then its blind spots.
    "no backend call logged, and no new text appeared",
    "that also looks like this for a popup, a value-only update, or a screen that reuses the same labels",
  ]) {
    assert.ok(SAMPLE.some((l) => l.includes(advice)), `the sample dropped: ${advice}`);
    // In code, not in a comment. A plain substring search over the whole file
    // would be satisfied by the very sentence being removed if it survived in
    // the comment above the line that used to print it — the docs would then be
    // held to a copy the tool no longer emits.
    assert.ok(
      CODE_LINES.some((l) => l.includes(advice)),
      `the crawl no longer prints: ${advice}`,
    );
  }
});

// --- the reference text ------------------------------------------------------

/** Flag names in the arity tables, i.e. everything parseArgs will accept. */
const TABLE_FLAGS = (() => {
  const from = CLI_SRC.indexOf("const COMMON_FLAGS");
  const to = CLI_SRC.indexOf("export const KNOWN_VERBS");
  assert.ok(from > 0 && to > from, "the arity tables moved");
  const names = new Set();
  // Not anchored to the line start: inspect/init/doctor keep their whole table
  // on one line, and those five flags are exactly the ones a line-anchored
  // scrape would silently miss.
  for (const m of CLI_SRC.slice(from, to).matchAll(/(?<![\w-])"?([A-Za-z][\w-]*)"?:\s*"(?:boolean|value|optional)"/g)) {
    names.add(m[1]);
  }
  return names;
})();

/** Every `--flag` / `-f` token in a stretch of the help text. */
const flagsIn = (text) => [...text.matchAll(/(?<![\w-])(--?[A-Za-z][\w-]*)/g)].map((m) => m[1]);

/** USAGE split into its headed sections. */
const SECTIONS = (() => {
  const out = new Map();
  const heads = [...USAGE.matchAll(/^([A-Z][A-Z /]+)(?: — (.*))?$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].index : USAGE.length;
    out.set(heads[i][1].trim(), { verbs: heads[i][2], body: USAGE.slice(heads[i].index + heads[i][0].length, end) });
  }
  return out;
})();

/** Does the parser take this flag for this verb? */
function accepts(verb, flag, companion = []) {
  try {
    parseArgs([verb, ...companion, flag, "x"]);
    return true;
  } catch (e) {
    if (e instanceof ArgError) return false;
    throw e;
  }
}

/** The help entry for one flag: its line, plus any indented continuation. */
function entryFor(body, flag) {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(flag + " ") || l.trimStart() === flag);
  if (at < 0) return "";
  const out = [lines[at]];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s{20,}\S/.test(lines[i])) out.push(lines[i]);
    else break;
  }
  return out.join(" ");
}

test("every flag the parser accepts is in the help text", () => {
  // --quiet and --variant were both real, both working, and findable only by
  // reading cli.ts.
  assert.ok(TABLE_FLAGS.size >= 35, `only ${TABLE_FLAGS.size} flags found; the table scrape has drifted`);
  for (const oneLiner of ["hidden", "force", "out", "deep", "set-basecamp"]) {
    assert.ok(TABLE_FLAGS.has(oneLiner), `the scrape missed ${oneLiner}, so this check has a blind spot`);
  }
  for (const name of TABLE_FLAGS) {
    const spelled = name.length === 1 ? `-${name}` : `--${name}`;
    assert.match(
      USAGE,
      new RegExp(`(?<![\\w-])${spelled}(?![\\w-])`),
      `--help never mentions ${spelled}`,
    );
  }
  for (const spelled of ["--quiet", "-q", "--variant"]) {
    assert.match(USAGE, new RegExp(`(?<![\\w-])${spelled}(?![\\w-])`), `${spelled} is undocumented again`);
  }
});

test("a flag filed under COMMON OPTIONS is one every command accepts, doctor included", () => {
  // The reported defect, verbatim: `sitometres doctor --basecamp X --headed`,
  // typed out of a block headed "every command", and --headed was in it.
  const section = SECTIONS.get("COMMON OPTIONS");
  assert.ok(section, "the COMMON OPTIONS heading is gone");
  assert.equal(section.verbs, "every command", "the heading still claims every command");

  const listed = [...new Set(flagsIn(section.body))];
  assert.ok(listed.length >= 5, `only ${listed.length} flags under COMMON OPTIONS; the scrape has drifted`);
  for (const flag of listed) {
    for (const verb of KNOWN_VERBS) {
      assert.ok(accepts(verb, flag), `${flag} is filed under "every command" but \`${verb}\` rejects it`);
    }
  }
  // doctor has the smallest table, so it is the one that broke; name it.
  assert.ok(accepts("doctor", "--basecamp"), "sitometres doctor --basecamp <path> must work");
  assert.ok(listed.includes("--basecamp"));
});

test("a flag filed under a per-command heading is accepted by the commands it names", () => {
  const cases = [
    ["APP OPTIONS", ["smoke", "run", "inspect", "init"]],
    ["SMOKE OPTIONS", ["smoke"]],
    ["RUN OPTIONS", ["run"]],
    ["DOCTOR OPTIONS", ["doctor"]],
  ];
  for (const [heading, verbs] of cases) {
    const section = SECTIONS.get(heading);
    assert.ok(section, `the ${heading} heading is gone`);
    const listed = [...new Set(flagsIn(section.body))];
    assert.ok(listed.length >= 2, `only ${listed.length} flags under ${heading}`);
    for (const flag of listed) {
      for (const verb of verbs) {
        // A flag whose own entry says it requires a companion is probed with
        // it. --breakpoint is refused on its own by design — it parsed, was
        // stored and was then discarded, so the spec ran past the step the user
        // asked to stop at — and the help text says "Requires --debug". Probing
        // it bare would assert the opposite of what the line documents.
        const companion = /requires --debug/i.test(entryFor(section.body, flag)) ? ["--debug"] : [];
        assert.ok(
          accepts(verb, flag, companion),
          `${flag} is filed under ${heading} but \`${verb}\` rejects it`,
        );
      }
    }
  }

  // "INSPECT / INIT OPTIONS" is checked more weakly on purpose: three of its
  // four entries name their own command in the description ("(inspect)",
  // "(init)"), so the heading is a pair of sections sharing a title. What can
  // still be asserted is that nothing is filed there that NEITHER command
  // takes. Note that --hidden carries no such qualifier and `init` rejects it.
  const both = SECTIONS.get("INSPECT / INIT OPTIONS");
  assert.ok(both, "the INSPECT / INIT OPTIONS heading is gone");
  for (const flag of new Set(flagsIn(both.body))) {
    assert.ok(
      accepts("inspect", flag) || accepts("init", flag),
      `${flag} is filed under INSPECT / INIT OPTIONS and neither command takes it`,
    );
  }
});

test("APP OPTIONS says doctor refuses these, and doctor really does refuse them", () => {
  // The other half of the fix. Moving --headed out of COMMON OPTIONS is only
  // honest if the new heading's claim — "doctor does not [launch an app], and
  // refuses them rather than accepting and ignoring them" — is true.
  const section = SECTIONS.get("APP OPTIONS");
  assert.match(section.body, /refuses them rather than accepting and ignoring them/);
  for (const flag of new Set(flagsIn(section.body))) {
    assert.ok(!accepts("doctor", flag), `doctor accepts ${flag}, which APP OPTIONS says it refuses`);
  }
  assert.throws(
    () => parseArgs(["doctor", "--headed"]),
    (e) => e instanceof ArgError && /does not mean anything for `doctor`/.test(e.message) && /smoke/.test(e.hint),
    "and the refusal has to say where the flag does work",
  );
});

test("--strict is documented in README.md and in SKILL.md, and is the gate they say it is", async () => {
  // It is the only thing standing between "the run proved nothing" and a green
  // CI job, and it was in neither file: a reader had no way to learn that a
  // default run exits 0 when it could not read a single line of evidence.
  for (const [name, doc] of [["README.md", README], ["SKILL.md", SKILL]]) {
    const mentions = [...doc.matchAll(/(?<![\w-])--strict(?![\w-])/g)];
    assert.ok(mentions.length > 0, `${name} never mentions --strict`);
    // Near a mention, not merely somewhere in the file. A loose whole-document
    // search passed on README.md for a sentence about collapsed list rows —
    // "clicking 265 of them proves nothing" — so deleting the explanation of
    // --strict would have left this green. Both files wrap, so the sentence may
    // straddle a newline.
    assert.ok(
      mentions.some((m) => /prove[ds]\s+nothing/.test(doc.slice(m.index, m.index + 500))),
      `${name} mentions --strict but never says, beside it, what it is for`,
    );
  }
  // And it is a real flag for both verbs that can produce a verdict, so the
  // documented `sitometres my_app --junit results.xml --strict` line parses.
  assert.ok(accepts("smoke", "--strict"));
  assert.ok(accepts("run", "--strict"));
  assert.deepEqual(parseArgs(["my_app", "--junit", "results.xml", "--strict"]).verb, "smoke");

  // The README's CI section makes two claims about the exit code. Both are
  // claims about crawlExitCode, so hold the prose to the function rather than
  // to a regex over its own wording.
  const { crawlProvedNothing, crawlExitCode } = await import("../dist/commands/smoke.js");

  assert.match(README, /does \*\*not\*\* fail merely because a control was `unclear`/);
  const unclearButBusy = [
    { outcome: "unclear", calls: ["medusa_core.getZones"] },
    { outcome: "unclear", calls: ["medusa_core.pendingRequests"] },
  ];
  assert.equal(crawlProvedNothing(unclearButBusy), false, "a crawl that saw calls proved something");
  assert.equal(
    crawlExitCode({ problems: 0, strict: true, provedNothing: false, evidenceUnreadable: false }),
    0,
    "so --strict must not fail it — a --strict that failed on `unclear` fails every healthy crawl",
  );

  // "By default the exit code is 1 only when something actually failed — an
  // INCONCLUSIVE run, one whose evidence could not be read, exits 0."
  const gate = { problems: 0, provedNothing: true, evidenceUnreadable: true };
  assert.equal(crawlExitCode({ ...gate }), 0, "the default really does let a run that proved nothing through");
  assert.equal(crawlExitCode({ ...gate, strict: true }), 1, "and --strict really is what closes it");
  assert.equal(crawlProvedNothing([{ outcome: "nothing", calls: [] }]), true);
});
