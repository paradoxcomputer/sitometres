// ---------------------------------------------------------------------------
// Machine-readable output for CI.
//
// JUnit has no third state, so INCONCLUSIVE is emitted as <skipped> with the
// reason attached: a build that cannot supply the evidence should not turn a
// pipeline red, but it must not silently read as a pass either.
// ---------------------------------------------------------------------------

import type { FidelityReport } from "../runner/fidelity.js";
import type { RunResult } from "../runner/runner.js";

export interface MachineReport {
  tool: "sitometres";
  version: string;
  app: string | null;
  basecamp: string;
  /** Throwaway $HOME the app saw, or null when it saw the real one. */
  sandboxHome?: string | null;
  fidelity: FidelityReport;
  verdict: RunResult["verdict"];
  durationMs: number;
  steps: RunResult["steps"];
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
    ...(input.sandboxHome !== undefined ? { sandboxHome: input.sandboxHome } : {}),
    fidelity: input.fidelity,
    verdict,
    durationMs: input.durationMs,
    steps,
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
          `      <failure message="${firstLine(msg)}">${msg}</failure>\n    </testcase>`;
      }
      if (s.verdict === "inconclusive") {
        return `    <testcase classname="${esc(suiteName)}" name="${name}" time="${time}">\n` +
          `      <skipped message="${firstLine(esc(detail || report.fidelity.summary))}"/>\n    </testcase>`;
      }
      return `    <testcase classname="${esc(suiteName)}" name="${name}" time="${time}"/>`;
    })
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites>\n` +
    `  <testsuite name="${esc(suiteName)}" tests="${steps.length}" failures="${failures}" ` +
    `skipped="${skipped}" time="${(report.durationMs / 1000).toFixed(3)}">\n${cases}\n  </testsuite>\n` +
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
  return s
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
