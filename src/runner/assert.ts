// ---------------------------------------------------------------------------
// Deciding whether a step did what it claimed.
//
// Three verdicts, and the third one matters:
//
//   PASS          every expectation was checked and held.
//   FAIL          an expectation was checked and did not hold.
//   INCONCLUSIVE  an expectation COULD NOT BE CHECKED on this build.
//
// A Release Basecamp compiles Qt logging out, so `calls:` and `events:` have
// no evidence to read. Reporting those as PASS would be a lie and reporting
// them as FAIL would be a false alarm; INCONCLUSIVE is the honest answer, and
// the report says how to get the evidence back.
// ---------------------------------------------------------------------------

import type { LogCursor } from "../logs/buffer.js";
import { attributeTo, callName, callsIn, pairFailures, UNATTRIBUTED, type ParsedLine } from "../logs/classify.js";
import { asArray, type Expect } from "../spec/schema.js";
import type { InspectorClient } from "../inspector/client.js";
import { normaliseText, resolveAll, toSelector } from "./selector.js";
import type { UiSnapshot } from "./snapshot.js";

export type Verdict = "pass" | "fail" | "inconclusive";

export interface Check {
  kind:
    | "text" | "notText" | "state" | "calls" | "noCalls"
    | "callsSucceed" | "noErrors" | "noWarnings" | "console" | "events";
  description: string;
  verdict: Verdict;
  detail?: string;
}

export interface AssertContext {
  inspector: InspectorClient;
  snapshot: UiSnapshot;
  /** Log lines produced since the step's action, already parsed. */
  window: ParsedLine[];
  /** QML root of the app under test, for `state` expressions. */
  qmlRootId: string | null;
  /** Module name of the app under test, for error attribution. */
  appName: string | null;
  /** False when the build emits no Qt logging. */
  logsUsable: boolean;
  /** Call names to ignore, e.g. a polling loop. */
  ignoreCalls: string[];
  cursor: LogCursor;
}

/**
 * Backend calls observed in the window, as "module.method".
 *
 * Both dispatch styles. This used to read `call_started` only, which meant
 * every `logos.callModuleAsync` call was invisible: `calls:` could not pass for
 * one and `no_calls:` passed when it had been made.
 */
export function observedCalls(window: ParsedLine[], ignore: string[] = []): string[] {
  const out: string[] = [];
  for (const c of callsIn(window)) {
    const name = callName(c);
    if (ignore.some((i) => matchesCall(name, i))) continue;
    out.push(name);
  }
  return out;
}

/** "medusa_core.getZones" matches "medusa_core.getZones", "getZones", "medusa_core.*". */
export function matchesCall(observed: string, wanted: string): boolean {
  if (observed === wanted) return true;
  const [mod, method] = observed.split(".", 2);
  if (wanted === method) return true;
  if (wanted.endsWith(".*") && mod === wanted.slice(0, -2)) return true;
  // An async call whose module could not be recovered is "?.method". Matching
  // it against a qualified `mod.method` is the honest reading: the method did
  // fire, and refusing to match would resurrect the false pass this fixes.
  if (mod === "?" && method !== undefined && wanted.endsWith("." + method)) return true;
  return false;
}

/**
 * Should this ignore list silence this failure?
 *
 * The one rule, used by both the spec runner and the crawl. They had diverged:
 * the crawl also matched `entry.endsWith("." + method)`, which silences ANOTHER
 * module's identically-named method — the exact defect that made a hardcoded
 * "medusa_core.getJob" suppress any module's getJob — so the two graded the
 * same log window differently.
 *
 * A hedged attribution is only silenced when every candidate is also ignored;
 * otherwise the ignore list could swallow the timeout of the call under test.
 * An unattributed failure is silenced only by naming it explicitly, because no
 * qualified entry can ever match it.
 */
export function suppressedBy(
  f: { module?: string; method: string; confident: boolean; alternatives: string[] },
  ignore: string[],
): boolean {
  if (ignore.length === 0) return false;
  const mod = f.module ?? "?";
  if (f.method === UNATTRIBUTED) return ignore.includes(UNATTRIBUTED);
  const hit = (name: string) => ignore.some((i) => matchesCall(name, i));
  if (!hit(`${mod}.${f.method}`)) return false;
  return f.alternatives.every((alt) => hit(`${mod}.${alt}`));
}

export async function runChecks(ctx: AssertContext, expect: Expect): Promise<Check[]> {
  const checks: Check[] = [];
  /**
   * True when a check would have run but the session cannot read the evidence.
   *
   * Zero checks is legitimately a pass — `calls_succeed: false` produces it by
   * design — but zero checks BECAUSE nothing could be read is not. Under
   * --attach, where fidelity is always quiet, the step `init` generates ran no
   * checks at all and reported PASS, while the README promises that log-based
   * assertions there report INCONCLUSIVE rather than inventing a pass.
   */
  let suppressed = false;

  // --- visible text -------------------------------------------------------
  for (const sel of asArray(expect.text)) {
    const s = toSelector(sel);
    const found = resolveAll(ctx.snapshot, s).length > 0;
    checks.push({
      kind: "text",
      description: `sees ${JSON.stringify(s.text ?? JSON.stringify(s))}`,
      verdict: found ? "pass" : "fail",
      ...(found ? {} : { detail: nearestLabels(ctx.snapshot, s.text) }),
    });
  }

  for (const sel of asArray(expect.notText)) {
    const s = toSelector(sel);
    const hits = resolveAll(ctx.snapshot, s);
    checks.push({
      kind: "notText",
      description: `does not see ${JSON.stringify(s.text ?? JSON.stringify(s))}`,
      verdict: hits.length === 0 ? "pass" : "fail",
      ...(hits.length === 0 ? {} : { detail: `still visible on ${hits[0]!.node.type}` }),
    });
  }

  // --- app state ----------------------------------------------------------
  for (const expr of asArray(expect.state)) {
    if (!ctx.qmlRootId) {
      checks.push({
        kind: "state",
        description: `state ${JSON.stringify(expr)}`,
        verdict: "inconclusive",
        detail:
          "the app's QML root was not found, so there is nothing to evaluate against. " +
          "Either no `open:` step has run yet, or the dock holds no QML type matching the `view` " +
          "your manifest declares.",
      });
      continue;
    }
    try {
      const res = await ctx.inspector.evaluate(expr, ctx.qmlRootId);
      const truthy = Boolean(res.result) && !res.undefined;
      checks.push({
        kind: "state",
        description: `state ${JSON.stringify(expr)}`,
        verdict: truthy ? "pass" : "fail",
        ...(truthy ? {} : { detail: `evaluated to ${JSON.stringify(res.result)}` }),
      });
    } catch (err) {
      checks.push({
        kind: "state",
        description: `state ${JSON.stringify(expr)}`,
        verdict: "fail",
        detail: (err as Error).message,
      });
    }
  }

  // --- backend calls ------------------------------------------------------
  // asArray, not `?? []`: validateSpec rejects a scalar, but runChecks is a
  // public export and a caller constructing an Expect by hand must not be able
  // to spread a string into per-character checks that all pass.
  const wantCalls = asArray(expect.calls);
  const wantNoCalls = asArray(expect.noCalls);
  const wantEvents = asArray(expect.events);

  if (wantCalls.length > 0 || wantNoCalls.length > 0 || wantEvents.length > 0) {
    if (!ctx.logsUsable) {
      for (const c of wantCalls) {
        checks.push({
          kind: "calls",
          description: `calls ${c}`,
          verdict: "inconclusive",
          detail: "this Basecamp build emits no call logging (see the run header)",
        });
      }
      for (const c of wantNoCalls) {
        checks.push({ kind: "noCalls", description: `does not call ${c}`, verdict: "inconclusive" });
      }
      for (const e of wantEvents) {
        checks.push({ kind: "events", description: `emits ${e}`, verdict: "inconclusive" });
      }
    } else {
      const seen = observedCalls(ctx.window, ctx.ignoreCalls);
      for (const want of wantCalls) {
        const hit = seen.some((o) => matchesCall(o, want));
        checks.push({
          kind: "calls",
          description: `calls ${want}`,
          verdict: hit ? "pass" : "fail",
          ...(hit ? {} : { detail: seen.length ? `saw instead: ${uniq(seen).join(", ")}` : "no backend calls at all" }),
        });
      }
      for (const want of wantNoCalls) {
        const hit = seen.some((o) => matchesCall(o, want));
        checks.push({
          kind: "noCalls",
          description: `does not call ${want}`,
          verdict: hit ? "fail" : "pass",
          ...(hit ? { detail: "it was called" } : {}),
        });
      }
      const events = ctx.window.filter((p) => p.signal?.kind === "event_emitted").map((p) => p.signal!.method!);
      for (const want of wantEvents) {
        const hit = events.includes(want);
        checks.push({
          kind: "events",
          description: `emits ${want}`,
          verdict: hit ? "pass" : "fail",
          ...(hit ? {} : { detail: events.length ? `saw: ${uniq(events).join(", ")}` : "no events emitted" }),
        });
      }
    }
  }

  // --- call failures ------------------------------------------------------
  //
  // Scope, precisely: this catches TRANSPORT failures — the callee never
  // answered, or the 20 s reply timeout expired. It does NOT catch a call that
  // reached the module and came back with an error, because
  // LogosQmlBridge::callModule returns those to QML as a JSON payload
  // (`{"error":"Invalid response"}`, `"Module source unavailable"`, …) and
  // logs nothing at all. Verified live: calling a nonexistent method on a
  // loaded module produced a normal call_started/dispatched/transport trail and
  // no failure line whatsoever.
  //
  // So a green here means "nothing hung", not "the call did what you wanted".
  // Assert the effect with `state:` for that. The check is named accordingly.
  if (expect.callsSucceed !== false && !ctx.logsUsable && expect.callsSucceed === true) {
    // Named explicitly, and unreadable. Skipping it silently is how a step
    // whose only assertion was a log key passed on a session that could not
    // read logs at all.
    checks.push({
      kind: "callsSucceed",
      description: "no failed or timed-out backend calls",
      verdict: "inconclusive",
      detail: "this session sees no call logging (see the run header)",
    });
  }
  if (expect.callsSucceed !== false && !ctx.logsUsable) suppressed = true;
  if (expect.callsSucceed !== false && ctx.logsUsable) {
    const failures = [...pairFailures(ctx.window).values()];
    // An ignore entry only silences a failure it can be shown to own. A hedged
    // attribution whose alternatives include a call the user did NOT ignore is
    // reported: silencing it meant `ignore_calls: [poll]` could swallow the
    // timeout of the very call the step was testing.
    const relevant = failures.filter((f) => !suppressedBy(f, ctx.ignoreCalls));
    // Split by whether the failure can be tied to anything this step did.
    //
    // An UNANCHORED failure has no module, no method and no dispatch in the window to match
    // it to — the tool cannot say it belongs to this step, and in an app that polls it
    // usually does not: a background poll fails on its own schedule and lands in whichever
    // window happens to be open. Failing the step on that blames a gesture for something it
    // did not cause, and the only escape was to disable the whole check with
    // `calls_succeed: false`, which then hides the failures that ARE attributable.
    //
    // So: report it, do not fail on it. `inconclusive` is what the rest of this file already
    // uses for "the evidence cannot answer", and --strict still surfaces it.
    const unanchored = relevant.filter((f) => f.method === UNATTRIBUTED && f.alternatives.length === 0);
    const blamed = relevant.filter((f) => !(f.method === UNATTRIBUTED && f.alternatives.length === 0));
    if (blamed.length > 0 || wantCalls.length > 0) {
      checks.push({
        kind: "callsSucceed",
        description: "no failed or timed-out backend calls",
        verdict: blamed.length === 0 ? "pass" : "fail",
        ...(blamed.length === 0 ? {} : { detail: describeFailures(blamed) }),
      });
    }
    if (unanchored.length > 0) {
      checks.push({
        kind: "callsSucceed",
        description: `${unanchored.length === 1 ? "a call" : `${unanchored.length} calls`} failed, unattributable to this step`,
        verdict: "inconclusive",
        detail:
          `nothing dispatched in this step's window matches ${unanchored.length === 1 ? "it" : "them"}, ` +
          `so ${unanchored.length === 1 ? "it is" : "they are"} reported rather than blamed on this step — ` +
          `a background poll is the usual source. Name the call in \`calls:\` to assert it properly, ` +
          `or \`ignore_calls: ["${UNATTRIBUTED}"]\` to drop it entirely.`,
      });
    }
  }

  // --- the app's own console output ---------------------------------------
  // QML console.log reaches the stream as `qml: <text>`; console.error and
  // console.warn land there too. It is the simplest oracle an app author can
  // add for something the UI does not show.
  for (const want of asArray(expect.console)) {
    if (!ctx.logsUsable) {
      checks.push({ kind: "console", description: `logs ${JSON.stringify(want)}`, verdict: "inconclusive" });
      continue;
    }
    const lines = ctx.window.filter((p) => p.signal?.kind === "qml_console").map((p) => p.signal!.detail ?? "");
    const hit = lines.some((l) => l.includes(want));
    checks.push({
      kind: "console",
      description: `logs ${JSON.stringify(want)}`,
      verdict: hit ? "pass" : "fail",
      ...(hit ? {} : { detail: lines.length ? `console output was: ${lines.slice(0, 3).join(" | ")}` : "the app logged nothing" }),
    });
  }

  // --- errors -------------------------------------------------------------
  // Best effort: silently skipped on a build that cannot report errors, so a
  // quiet build does not litter every step with INCONCLUSIVE.
  if (expect.noErrors === true && !ctx.logsUsable) {
    checks.push({
      kind: "noErrors",
      description: "no new QML errors",
      verdict: "inconclusive",
      detail: "this session sees no QML diagnostics (see the run header)",
    });
  }
  if (expect.noErrors !== false && !ctx.logsUsable) suppressed = true;
  if (expect.noErrors !== false && ctx.logsUsable) {
    const errors = ctx.window.filter((p) => {
      if (p.signal?.kind !== "qml_error") return false;
      if (!ctx.appName) return true;
      return attributeTo(p) === ctx.appName;
    });
    checks.push({
      kind: "noErrors",
      description: ctx.appName ? `no new QML errors in ${ctx.appName}` : "no new QML errors",
      verdict: errors.length === 0 ? "pass" : "fail",
      ...(errors.length === 0 ? {} : { detail: errors.slice(0, 3).map((e) => e.message).join("\n      ") }),
    });
  }

  // noWarnings is ONLY ever explicit — it is off by default — so the
  // anti-litter argument that justifies silently skipping the defaults cannot
  // apply to it at all.
  if (expect.noWarnings === true && !ctx.logsUsable) {
    checks.push({
      kind: "noWarnings",
      description: "no new QML warnings",
      verdict: "inconclusive",
      detail: "this session sees no QML diagnostics (see the run header)",
    });
  }
  if (expect.noWarnings === true && ctx.logsUsable) {
    const warnings = ctx.window.filter((p) => {
      if (p.signal?.kind !== "qml_warning") return false;
      if (!ctx.appName) return true;
      return attributeTo(p) === ctx.appName;
    });
    checks.push({
      kind: "noWarnings",
      description: ctx.appName ? `no new QML warnings in ${ctx.appName}` : "no new QML warnings",
      verdict: warnings.length === 0 ? "pass" : "fail",
      ...(warnings.length === 0 ? {} : { detail: warnings.slice(0, 3).map((w) => w.message).join("\n      ") }),
    });
  }

  // Nothing could be checked, and not because the spec said so.
  if (checks.length === 0 && suppressed) {
    checks.push({
      kind: "noErrors",
      description: "anything at all about this step",
      verdict: "inconclusive",
      detail:
        "this session cannot read log evidence and the step asserts nothing else, " +
        "so nothing about it was verified (see the run header)",
    });
  }

  return checks;
}

/**
 * Can this check only be falsified by something that has not happened yet?
 *
 * A click is POSTED, not sent, so at the moment the gesture returns no handler
 * has run. A positive expectation ("sees X", "calls Y") is monotone: once it
 * holds it stays held, so returning as soon as it holds is correct. A negative
 * one ("does not call Y") is true at t=0 for every step ever written, and
 * accepting it immediately grades the app before it has done anything.
 */
export function isNegative(kind: Check["kind"]): boolean {
  return kind === "notText" || kind === "noCalls" || kind === "noErrors" || kind === "noWarnings" ||
    kind === "callsSucceed";
}

/** True when every check is one that waiting cannot make more true. */
export function allMonotone(checks: Check[]): boolean {
  return checks.length > 0 && !checks.some((c) => isNegative(c.kind));
}

/**
 * Once this check has failed, can waiting ever un-fail it?
 *
 * The dual of `isNegative`, and it is not simply its inverse. These four read
 * the step's LOG WINDOW, which only ever grows: a forbidden call, a QML error,
 * a warning or a failed call that is in the window at t is in the window at
 * every later t, so the verdict is already final. `notText` is excluded
 * deliberately — it reads the live snapshot, and "Loading…" disappearing is
 * exactly the case a step waits for.
 *
 * Without this, a step whose negative expectation had already been falsified
 * kept polling to its full timeout: a ten-step spec failing on negatives took
 * five minutes to report what it knew in the first second, and one test in this
 * repo's own suite spent 30 of the suite's 30.3 seconds waiting out the default.
 */
export function isIrrecoverable(kind: Check["kind"]): boolean {
  return kind === "noCalls" || kind === "noErrors" || kind === "noWarnings" || kind === "callsSucceed";
}

/**
 * Is every failing check here beyond recovery, so polling on is pointless?
 *
 * False while any failing check could still come good — a `text:` that has not
 * rendered yet, a `calls:` whose dispatch is in flight — because returning then
 * would report those as failed when the step still had budget to satisfy them.
 */
export function settled(checks: Check[]): boolean {
  const failing = checks.filter((c) => c.verdict === "fail");
  return failing.length > 0 && failing.every((c) => isIrrecoverable(c.kind));
}

export function verdictOf(checks: Check[]): Verdict {
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  if (checks.some((c) => c.verdict === "inconclusive")) return "inconclusive";
  return "pass";
}

function describeFailures(failures: Array<{ module?: string; method: string; confident: boolean; alternatives: string[] }>): string {
  const lines = failures.map((f) => {
    const name = `${f.module ?? "?"}.${f.method}`;
    if (f.confident) return `${name} failed or timed out`;
    // An unanchored failure has no candidates at all. The hedged sentence
    // assumed at least one and produced "most likely ?.(unknown), but  were
    // also in flight" — prose that is both broken and unactionable.
    if (f.alternatives.length === 0) {
      return (
        `a call failed or timed out, and no dispatch in this step's window could be matched to it ` +
        `(suppress with ignore_calls: ["${UNATTRIBUTED}"] if it is background noise)`
      );
    }
    return (
      `a call failed or timed out — most likely ${name}, but ${f.alternatives.join(", ")} ` +
      `${f.alternatives.length === 1 ? "was" : "were"} also in flight`
    );
  });
  return (
    lines.join("\n      ") +
    `\n      (the failure line names neither module nor method; it is matched to the transport ` +
    `line before it, so with overlapping calls the attribution is a best guess)`
  );
}

function uniq(v: string[]): string[] {
  return [...new Set(v)];
}

function nearestLabels(snapshot: UiSnapshot, wanted: string | undefined): string {
  if (!wanted) return "";
  const want = normaliseText(wanted).toLowerCase();
  const near = snapshot
    .labels()
    .filter((l) => normaliseText(l).toLowerCase().includes(want) || want.includes(normaliseText(l).toLowerCase()))
    .slice(0, 3);
  if (near.length > 0) return `closest visible: ${near.map((l) => JSON.stringify(l)).join(", ")}`;
  const some = snapshot.labels().slice(0, 5);
  return some.length ? `visible labels include: ${some.map((l) => JSON.stringify(l)).join(", ")}` : "nothing visible in scope";
}
