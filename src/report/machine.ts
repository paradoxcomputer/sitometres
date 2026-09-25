// ---------------------------------------------------------------------------
// Machine-readable output for CI.
//
// JUnit has no third state, so INCONCLUSIVE is emitted as <skipped> with the
// reason attached: a build that cannot supply the evidence should not turn a
// pipeline red, but it must not silently read as a pass either.
// ---------------------------------------------------------------------------

import type { DiscoveredApp } from "../app/discover.js";
import type { StagedRecord } from "../app/fingerprint.js";
import type { FidelityReport } from "../runner/fidelity.js";
import type { RunResult } from "../runner/runner.js";

/**
 * Which build a verdict is about.
 *
 * Picked off DiscoveredApp rather than restated, because these are its fields
 * and a second copy of them is a second thing to keep in step. A repo usually
 * holds the same app twice — an unpacked plugins/<name>/ beside a freshly
 * built result/*.lgx — so "which one did you grade" has a real answer that the
 * run already knows and used to spend on the terminal header alone.
 */
export type BuildSource = Pick<DiscoveredApp, "origin" | "form" | "builtAt"> & {
  /** The app's own version, when its manifest declares one. Not the tool's. */
  version?: string;
};

/**
 * The build a report is about, or undefined when the run staged none.
 *
 * One function rather than the literal spelled out at each emit site: smoke has
 * five of them and the two on the failure path were written without it, so a
 * red job's artifact — the one a reader actually opens — could not say which
 * build failed. A second copy of these four fields is a second thing to forget.
 */
export function buildSourceOf(
  app: Pick<DiscoveredApp, "origin" | "form" | "builtAt" | "manifest"> | null | undefined,
): BuildSource | undefined {
  if (!app) return undefined;
  return {
    origin: app.origin,
    form: app.form,
    builtAt: app.builtAt,
    // Typed, not merely truthy: `version` is declared `string`, this field is
    // published in --json and as a JUnit attribute, and normalise is what keeps
    // that promise. Saying so here means the artifact shape cannot be broken
    // from a distance by whatever a manifest happens to hold.
    ...(typeof app.manifest.version === "string" && app.manifest.version
      ? { version: app.manifest.version }
      : {}),
  };
}

export interface MachineReport {
  tool: "sitometres";
  version: string;
  app: string | null;
  basecamp: string;
  /**
   * The build that was graded, when the run staged one.
   *
   * Optional because attach mode staged nothing: it drives a Basecamp somebody
   * else started, so there is no build it can name — the same reason
   * `basecamp` reads "(attached)" there.
   */
  source?: BuildSource;
  /** Throwaway $HOME the app saw, or null when it saw the real one. */
  sandboxHome?: string | null;
  fidelity: FidelityReport;
  verdict: RunResult["verdict"];
  durationMs: number;
  /** The runner's own step records, `comment:` included. See StepResult. */
  steps: RunResult["steps"];
  /**
   * Every staged artifact with its full sha256, the app under test first. Set
   * only when something was staged, so attach mode writes no hash at all.
   */
  staged?: StagedRecord[];
  /**
   * True for a spec whose `open:` steps and `in:` targets name more than one
   * app. It is what puts `sitometres.app` on each JUnit testcase, so a
   * single-app report's testcases stay exactly as they were.
   */
  multiApp?: boolean;
}

/**
 * A crawl expressed as a MachineReport, so `smoke` can emit JUnit and JSON.
 *
 * The zero-configuration command is the one an author would put in CI, and it
 * could not produce a machine-readable result at all: toJUnit was reachable
 * only from `run`. Each clicked control becomes a case, graded by what the
 * crawl concluded — `failed` is a failure, and an outcome that proves nothing
 * ("unclear", or a call that fired with no confirmation) is reported as
 * skipped rather than as a pass, for the same reason INCONCLUSIVE exists.
 */
export function crawlToMachineReport(input: {
  version: string;
  app: string | null;
  basecamp: string;
  /** Throwaway $HOME the app saw, or null when it saw the real one. */
  sandboxHome?: string | null;
  /** The build that was crawled; see MachineReport.source. */
  source?: BuildSource;
  fidelity: FidelityReport;
  durationMs: number;
  open: { ok: boolean; errors: string[] };
  clicks: Array<{ label: string; outcome: string; evidence: string[]; calls: string[]; newLabels?: string[] }>;
  /**
   * The two conditions `--strict` fails on, when `--strict` is in force.
   *
   * Passed only under `--strict`, because only then do they affect the exit
   * code — and the requirement is that everything the exit code counts appears
   * here. Without it a crawl of inert controls exited 1 with failures="0".
   */
  strictGate?: { provedNothing: boolean; evidenceUnreadable: boolean };
  /** Why the crawl stopped early, when it did. */
  endedEarly?: string;
  /** Set when a setup profile did not complete. */
  setupFailed?: string;
  /** Failures that no click owned — dispatched while opening, or unpairable. */
  orphanFailures?: string[];
  /** Controls the crawl could not click at all, e.g. the gesture threw. */
  unclickable?: Array<{ label: string; why: string }>;
  /** QML errors or failed calls seen while the app was opening. */
  openProblems?: string[];
  /** What was staged; see MachineReport.staged. */
  staged?: StagedRecord[];
}): MachineReport {
  const steps: MachineReport["steps"] = [];
  if (input.setupFailed) {
    // A setup that did not complete leaves the crawl on the wrong screen, so
    // everything after it is testing something other than what was asked for.
    steps.push({
      index: 0,
      name: "setup profile",
      action: "setup",
      verdict: "fail",
      durationMs: 0,
      checks: [{ kind: "state", description: "the setup profile completed", verdict: "fail", detail: input.setupFailed }],
      callsObserved: [],
    });
  }
  const openIssues = [...input.open.errors.map((e) => ({ kind: "noErrors" as const, text: e })),
    ...(input.openProblems ?? []).map((e) => ({ kind: "callsSucceed" as const, text: e }))];
  steps.push({
    index: steps.length,
    name: `open ${input.app ?? "app"}`,
    action: "open",
    // A step carrying failing checks is a failed step. Reading only `open.ok`
    // produced a "pass" whose own checks said "fail" — an artifact that
    // contradicts itself in the same element.
    verdict: input.open.ok && openIssues.length === 0 ? "pass" : "fail",
    durationMs: 0,
    // Each issue keeps its own kind: routing a failed CALL through a check
    // described as "no new QML errors" produced a list that could never contain
    // a QML error.
    checks: openIssues.map((e) => ({
      kind: e.kind,
      description:
        e.kind === "noErrors" ? "no new QML errors while opening" : "no failed backend calls while opening",
      verdict: "fail" as const,
      detail: e.text,
    })),
    callsObserved: [],
  });
  const clickBase = steps.length;
  input.clicks.forEach((c, i) => {
    const verdict =
      // `ran` and `nothing` are CONCLUSIVE observations — a call was dispatched,
      // or nothing happened — so reporting them as skipped was wrong, and it is
      // why --strict failed a perfectly healthy crawl. Only `unclear` means the
      // tool could not tell.
      c.outcome === "failed"
        ? "fail"
        : c.outcome === "unclear"
          ? "inconclusive"
          : "pass";
    steps.push({
      index: clickBase + i,
      name: `click ${JSON.stringify(c.label)}`,
      action: `click ${JSON.stringify(c.label)}`,
      verdict,
      durationMs: 0,
      checks: [
        {
          kind: "state" as const,
          description: `clicking ${JSON.stringify(c.label)} ${c.outcome}`,
          verdict,
          // Falling back to what the click put on screen. An `unclear` verdict
          // carries no evidence and no calls by construction — the screen
          // changed and nothing said whether it worked — so the one field a
          // reader could have used was empty for precisely the outcome that
          // most needs explaining, while the crawl had the changed labels in
          // hand and discarded them.
          ...(c.evidence.length
            ? { detail: c.evidence.join("; ") }
            : c.newLabels?.length
              ? { detail: `now shows: ${c.newLabels.slice(0, 6).join(", ")}` }
              : {}),
        },
      ],
      callsObserved: c.calls,
    });
  });
  for (const u of input.unclickable ?? []) {
    // A gesture that threw is a failure of the run, and it used to increment
    // `problems` — making the process exit 1 — while never reaching the report,
    // so the artifact said failures="0". The exit code and the artifact must
    // never disagree; a CI reader only sees the artifact.
    steps.push({
      index: steps.length,
      name: `click ${JSON.stringify(u.label)}`,
      action: `click ${JSON.stringify(u.label)}`,
      verdict: "fail",
      durationMs: 0,
      checks: [{ kind: "state", description: `clicking ${JSON.stringify(u.label)}`, verdict: "fail", detail: u.why }],
      callsObserved: [],
    });
  }
  if ((input.orphanFailures ?? []).length > 0) {
    steps.push({
      index: steps.length,
      name: "calls that failed outside any click",
      action: "reconcile",
      verdict: "fail",
      durationMs: 0,
      checks: (input.orphanFailures ?? []).map((n) => ({
        kind: "callsSucceed" as const,
        description: `${n} failed`,
        verdict: "fail" as const,
        detail: "dispatched while opening or during setup, or could not be paired with any dispatch",
      })),
      callsObserved: [],
    });
  }
  if (input.endedEarly) {
    // Without this the artifact said failures="0" for a run whose app had died
    // and whose process exited 1 — the JUnit and the exit code disagreeing is
    // the same lie in two places.
    steps.push({
      index: steps.length,
      name: "the crawl ran to completion",
      action: "crawl",
      verdict: "fail",
      durationMs: 0,
      checks: [{ kind: "state", description: "the app stayed responsive", verdict: "fail", detail: input.endedEarly }],
      callsObserved: [],
    });
  }
  // Under --strict these two conditions make the process exit 1, so they have
  // to be here or the artifact contradicts the exit code — the same defect
  // already closed for unclickable controls, orphan failures, a crawl that
  // ended early and a failed setup profile. The --strict conditions were simply
  // left out of that sweep, and a completed crawl of inert controls exited 1
  // with `verdict: "pass"` and failures="0".
  if (input.strictGate?.provedNothing || input.strictGate?.evidenceUnreadable) {
    steps.push({
      index: steps.length,
      name: "the crawl proved something",
      action: "strict",
      verdict: "fail",
      durationMs: 0,
      checks: [
        ...(input.strictGate.provedNothing
          ? [{
              kind: "state" as const,
              description: "at least one control did something observable",
              verdict: "fail" as const,
              detail: "--strict: no control produced a call or a confirmation, so this crawl proved nothing",
            }]
          : []),
        ...(input.strictGate.evidenceUnreadable
          ? [{
              kind: "callsSucceed" as const,
              description: "log evidence could be read",
              verdict: "fail" as const,
              detail: `--strict: ${input.fidelity.summary}`,
            }]
          : []),
      ],
      callsObserved: [],
    });
  }
  if (input.clicks.length === 0 && steps.every((s) => s.verdict === "pass")) {
    // A crawl that exercised nothing has not shown the app works. Reporting a
    // lone passing testcase for the open step reads to CI as a green run.
    steps.push({
      index: steps.length,
      name: "some control was exercised",
      action: "crawl",
      verdict: "inconclusive",
      durationMs: 0,
      checks: [{
        kind: "state",
        description: "at least one control was clicked",
        verdict: "inconclusive",
        detail: "no control was clicked, so nothing about this app was tested",
      }],
      callsObserved: [],
    });
  }
  const verdict: MachineReport["verdict"] = steps.some((s) => s.verdict === "fail")
    ? "fail"
    : steps.some((s) => s.verdict === "inconclusive")
      ? "inconclusive"
      : "pass";
  return {
    tool: "sitometres",
    version: input.version,
    app: input.app,
    basecamp: input.basecamp,
    ...(input.source ? { source: input.source } : {}),
    ...(input.sandboxHome !== undefined ? { sandboxHome: input.sandboxHome } : {}),
    fidelity: input.fidelity,
    verdict,
    durationMs: input.durationMs,
    steps,
    ...(input.staged?.length ? { staged: input.staged } : {}),
  };
}

export function toJson(report: MachineReport): string {
  return JSON.stringify(report, null, 2);
}

export function toJUnit(report: MachineReport): string {
  const steps = report.steps;
  const failures = steps.filter((s) => s.verdict === "fail").length;
  const skipped = steps.filter((s) => s.verdict === "inconclusive").length;
  const suiteName = report.app ? `sitometres.${report.app}` : "sitometres";

  const cases = steps
    .map((s) => {
      const name = esc(s.name);
      const time = (s.durationMs / 1000).toFixed(3);
      // Which app the step ran in, for a spec that drives more than one. Only
      // then: a single-app report's testcases stay byte-identical, and
      // <properties> ahead of the body is where JUnit puts per-case metadata.
      const appProp = report.multiApp && s.app
        ? `      <properties>\n        <property name="sitometres.app" value="${esc(s.app)}"/>\n      </properties>\n`
        : "";
      // Findings only. A step's `comment:` is in the JSON record, as a field of
      // its own; it is deliberately not here. Both bodies JUnit has are what
      // the run FOUND — <failure> and <skipped> — and there is no third slot a
      // reader would not take for a measurement, system-out least of all.
      const detail = s.checks
        .filter((c) => c.verdict !== "pass")
        .map((c) => `${c.description}${c.detail ? `: ${c.detail}` : ""}`)
        .join("\n");
      if (s.verdict === "fail") {
        // `detail` is "" when every failing check had no detail, and `??` does
        // not catch an empty string — so this used to emit
        // <failure message=""> : a failure that does not say what failed, in
        // the one artifact a CI reader actually sees.
        const msg = esc(s.error || detail || "the step failed with no further detail");
        return `    <testcase classname="${esc(suiteName)}" name="${name}" time="${time}">\n` +
          appProp +
          `      <failure message="${firstLine(msg)}">${msg}</failure>\n    </testcase>`;
      }
      if (s.verdict === "inconclusive") {
        return `    <testcase classname="${esc(suiteName)}" name="${name}" time="${time}">\n` +
          appProp +
          `      <skipped message="${firstLine(esc(detail || report.fidelity.summary))}"/>\n    </testcase>`;
      }
      if (appProp) {
        return `    <testcase classname="${esc(suiteName)}" name="${name}" time="${time}">\n` +
          appProp + `    </testcase>`;
      }
      return `    <testcase classname="${esc(suiteName)}" name="${name}" time="${time}"/>`;
    })
    .join("\n");

  // The build goes in the XML too, not only in the JSON: JUnit is the file a CI
  // reader actually opens, and a testsuite that names the app but not the build
  // cannot answer "what did this verdict test?" — which is the whole question
  // when a repo holds two copies of the app. <properties> is the element JUnit
  // has for this, publishers that do not render it ignore it, and the schema
  // orders it before the first <testcase>, so it goes in front of `cases`
  // rather than after. builtAt stays the epoch ms the JSON carries: a stat that
  // failed reads 0, and rendering that as 1970-01-01 would state a build date
  // nothing measured.
  const sourceProps = report.source
    ? `      <property name="sitometres.origin" value="${esc(report.source.origin)}"/>\n` +
      `      <property name="sitometres.form" value="${esc(report.source.form)}"/>\n` +
      `      <property name="sitometres.builtAt" value="${report.source.builtAt}"/>\n` +
      (report.source.version
        ? `      <property name="sitometres.version" value="${esc(report.source.version)}"/>\n`
        : "")
    : "";
  // Every staged artifact, dependencies included, with the full digest of the
  // file Basecamp loaded. A build time nobody could read is written as
  // `unknown`, not as 0, which a reader would take for 1970.
  const stagedProps = (report.staged ?? [])
    .map((r) => {
      const key = `sitometres.staged.${r.name}`;
      return (
        `      <property name="${esc(key)}.version" value="${esc(r.version ?? "")}"/>\n` +
        `      <property name="${esc(key)}.artifact" value="${esc(r.artifact)}"/>\n` +
        `      <property name="${esc(key)}.provenance" value="${esc(r.provenance)}"/>\n` +
        `      <property name="${esc(key)}.builtAt" value="${r.builtAt === null ? "unknown" : r.builtAt}"/>\n` +
        r.hashes.map((h) => `      <property name="${esc(`${key}.sha256.${h.path}`)}" value="${esc(h.sha256)}"/>\n`).join("")
      );
    })
    .join("");
  const props = sourceProps || stagedProps ? `    <properties>\n${sourceProps}${stagedProps}    </properties>\n` : "";

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites>\n` +
    `  <testsuite name="${esc(suiteName)}" tests="${steps.length}" failures="${failures}" ` +
    `skipped="${skipped}" time="${(report.durationMs / 1000).toFixed(3)}">\n${props}${cases}\n  </testsuite>\n` +
    `</testsuites>\n`
  );
}

/**
 * XML-escape, and strip what XML 1.0 cannot carry at all.
 *
 * Escaping the five entities is not enough: C0 control bytes are ILLEGAL in
 * XML 1.0, not merely awkward, and there is no escape for them — &#27; is as
 * invalid as the raw byte. Detail strings are built from the app's own log
 * lines, so any module that colours its output (a Rust tracing backend, a
 * QT_MESSAGE_PATTERN with colour, anything emitting ANSI) puts ESC into them.
 * The result was a JUnit file no parser would accept, which a CI publisher
 * reports as "no test results" — the exact hole this output exists to close.
 *
 * ANSI sequences are removed whole rather than byte-by-byte, so the message
 * stays readable instead of keeping "[31m" where the colour was.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function esc(s: string): string {
  // Coerced, not trusted. This is the last thing between a finished run and the
  // only file CI reads, and it used to be one `s.replace is not a function`
  // away from throwing away a green run's evidence - the failure mode this
  // output exists to prevent. The declared type says string; a value that
  // reached here as something else is a bug worth fixing at its source, but not
  // one worth losing the artifact over.
  return String(s)
    .replace(ANSI, "")
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}
