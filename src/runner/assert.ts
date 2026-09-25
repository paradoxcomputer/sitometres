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

import fs from "node:fs";
import path from "node:path";
import type { LogCursor } from "../logs/buffer.js";
import { attributeTo, callName, callsIn, describeCall, pairFailures, UNATTRIBUTED, type ParsedLine } from "../logs/classify.js";
import { asArray, evalTarget, type Expect, type FileExpect, type FileInput } from "../spec/schema.js";
import type { InspectorClient } from "../inspector/client.js";
import { type FidelityChannels, HOST_DEBUG_REMEDY, VIEW_HOST_REMEDY } from "./fidelity.js";
import { normaliseText, resolveAll, toSelector } from "./selector.js";
import type { UiSnapshot } from "./snapshot.js";

export type Verdict = "pass" | "fail" | "inconclusive";

/**
 * Split an expression on its TOP-LEVEL `&&`, ignoring any inside brackets or string literals.
 *
 * "evaluated to false" for a six-clause `state:` says nothing about which clause failed, and the
 * clauses are exactly how spec authors write compound oracles. Exported for tests.
 */
export function topLevelConjuncts(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "&" && expr[i + 1] === "&") {
      parts.push(expr.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

/** The left operand of a clause's top-level comparison, if it has one. Exported for tests. */
export function comparisonLhs(clause: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < clause.length; i++) {
    const c = clause[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && /[=!<>]/.test(c)) {
      const op = clause.slice(i).match(/^(===|!==|==|!=|>=|<=|>|<)/);
      if (op && !(c === "=" && clause[i - 1] && /[=!<>]/.test(clause[i - 1]!))) {
        const lhs = clause.slice(0, i).trim();
        return lhs.length > 0 ? lhs : null;
      }
    }
  }
  return null;
}

/**
 * A left-hand value as it may appear in a report: never something that looks like a secret.
 *
 * The operand is often a field, and a field may hold a recovery phrase or a key (a restore form,
 * a revealed secret). Reports are pasted into bug trackers, so a value that looks like a
 * mnemonic (seven or more consecutive lowercase words) or key material (32+ hex digits) is
 * reduced to its length. Exported for tests.
 */
export function reportableValue(shown: string): string {
  const looksLikePhrase = /(?:\b[a-z]{3,8}\b[\s,]+){6,}\b[a-z]{3,8}\b/.test(shown);
  const looksLikeKey = /[0-9a-fA-F]{32,}/.test(shown);
  if (looksLikePhrase || looksLikeKey) return `<redacted: ${shown.length} chars that look like a secret>`;
  return shown.slice(0, 300);
}

/**
 * Which clauses of a false compound expression are false, and what their left-hand sides hold.
 *
 * Best effort and read-only: each clause is evaluated on its own in the same root. A clause
 * that throws is reported as throwing. Returns "" when the expression has one clause, so a
 * simple failure reads exactly as before.
 */
async function explainFalse(inspector: InspectorClient, expr: string, rootId: string): Promise<string> {
  const clauses = topLevelConjuncts(expr);
  if (clauses.length < 2) return "";
  const notes: string[] = [];
  for (const clause of clauses) {
    try {
      const r = await inspector.evaluate(clause, rootId);
      if (Boolean(r.result) && !r.undefined) continue;
      let note = `false: ${clause}`;
      const lhs = comparisonLhs(clause);
      if (lhs) {
        try {
          const v = await inspector.evaluate(`JSON.stringify(${lhs})`, rootId);
          const shown = typeof v.result === "string" ? v.result : JSON.stringify(v.result);
          note += `  [${lhs} = ${shown === undefined ? "undefined" : reportableValue(shown)}]`;
        } catch {
          /* the clause's own verdict is the finding; its operand is a bonus */
        }
      }
      notes.push(note);
    } catch (err) {
      notes.push(`throws: ${clause}  (${(err as Error).message.slice(0, 200)})`);
    }
  }
  return notes.length ? "\n    " + notes.join("\n    ") : "";
}

export interface Check {
  kind:
    | "text" | "notText" | "state" | "calls" | "noCalls"
    | "callsSucceed" | "noErrors" | "noWarnings" | "console" | "events" | "file";
  description: string;
  verdict: Verdict;
  detail?: string;
  /** The app a `state:` check evaluated in, when it named one with `in:`. */
  in?: string;
}

/**
 * Where an `in:` expression can be evaluated, as the runner sees it.
 *
 *   ok          the app is open and this is its live QML root
 *   not-open    the app was staged but no step has opened it yet
 *   no-root     the app is open, but no QML root could be found in its dock
 *   not-staged  no staged UI app goes by that name; `detail` lists the ones that do
 */
export type InTarget =
  | { kind: "ok"; module: string; rootId: string }
  | { kind: "not-open"; module: string; detail: string }
  | { kind: "no-root"; module: string; detail: string }
  | { kind: "not-staged"; detail: string };

export interface AssertContext {
  inspector: InspectorClient;
  snapshot: UiSnapshot;
  /** Log lines produced since the step's action, already parsed. */
  window: ParsedLine[];
  /** QML root of the app the step is in, for `state` expressions. */
  qmlRootId: string | null;
  /**
   * The apps whose QML errors and warnings count against this step: the app
   * under test and every app the spec has opened so far, in that order. Empty
   * means attribute nothing, and count every error, as attach mode does.
   */
  appNames?: string[];
  /**
   * The app under test alone. Read only when `appNames` is absent, so a caller
   * written before a spec could open more than one app keeps its meaning.
   */
  appName?: string | null;
  /** Resolves `state: { expr, in: <app> }`. Supplied by the runner. */
  rootFor?: (app: string) => Promise<InTarget>;
  /** False when the build emits no Qt logging. */
  logsUsable: boolean;
  /**
   * Which of the two channels a Qt-verbose log can still be missing have
   * shown themselves so far this run (see ./fidelity.ts). Absent means "not
   * measured", and nothing is downgraded for it.
   */
  channels?: FidelityChannels;
  /**
   * The app this step runs in, when it is a view module: its calls are made
   * by its ui-host process, so they are only visible while that channel is.
   */
  viewModuleApp?: string | null;
  /** Call names to ignore, e.g. a polling loop. */
  ignoreCalls: string[];
  /**
   * The $HOME the app under test was given, for `file:` to resolve against.
   *
   * Null when the run chose none: attach mode drives a process sitometres did
   * not start, and resolving a spec's path against sitometres' OWN $HOME would
   * answer a question about a directory the app never saw. See appHomeFor.
   */
  appHome: string | null;
  /** The staged user-dir, so `file:` can reach module_data/. Null when none was staged. */
  userDirRoot: string | null;
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
  for (const entry of asArray(expect.state)) {
    const { expr, in: target } = evalTarget(entry);
    if (target !== undefined) {
      checks.push(await stateIn(ctx, expr, target));
      continue;
    }
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
      const why = truthy ? "" : await explainFalse(ctx.inspector, expr, ctx.qmlRootId);
      checks.push({
        kind: "state",
        description: `state ${JSON.stringify(expr)}`,
        verdict: truthy ? "pass" : "fail",
        ...(truthy ? {} : { detail: `evaluated to ${JSON.stringify(res.result)}${why}` }),
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

  // --- files the app left behind ------------------------------------------
  //
  // The other family that needs no log evidence, and the only one that can see
  // what an app did outside its own process: an export, a cache, a wallet file.
  // Scoped to the $HOME this run gave the app, because a spec naming an
  // absolute path anywhere else is asking about the developer's machine — and
  // in a sandboxed run such a path is absent by construction, so grading it
  // FAIL would blame the app for the sandbox.
  for (const input of asArray(expect.file)) {
    checks.push(fileCheck(ctx, toFileExpect(input)));
  }

  // --- backend calls ------------------------------------------------------
  // asArray, not `?? []`: validateSpec rejects a scalar, but runChecks is a
  // public export and a caller constructing an Expect by hand must not be able
  // to spread a string into per-character checks that all pass.
  const wantCalls = asArray(expect.calls);
  const wantNoCalls = asArray(expect.noCalls);
  const wantEvents = asArray(expect.events);
  /**
   * The app is a view module whose ui-host has not been heard from: on
   * Basecamp 0.3.0 its output is off unless QT_LOGGING_RULES turns the
   * logos.viewhost category on, and every call it makes is in that output.
   * An empty window then proves nothing about its calls either way.
   */
  const viewHostSilent = Boolean(ctx.viewModuleApp) && ctx.channels !== undefined && !ctx.channels.viewHost;
  /** A module's events are logged by its host at debug level (0.3.0), which may not reach the log. */
  const hostDebugSilent = ctx.channels !== undefined && !ctx.channels.hostDebug;

  if (ctx.logsUsable && viewHostSilent && (wantCalls.length > 0 || wantNoCalls.length > 0)) {
    const detail = `${ctx.viewModuleApp}'s ui-host output never reached this run. ${VIEW_HOST_REMEDY}`;
    for (const c of wantCalls) checks.push({ kind: "calls", description: `calls ${c}`, verdict: "inconclusive", detail });
    for (const c of wantNoCalls) checks.push({ kind: "noCalls", description: `does not call ${c}`, verdict: "inconclusive", detail });
  }
  if (ctx.logsUsable && hostDebugSilent && wantEvents.length > 0) {
    for (const e of wantEvents) {
      checks.push({ kind: "events", description: `emits ${e}`, verdict: "inconclusive", detail: HOST_DEBUG_REMEDY });
    }
  }
  const readCalls = !(ctx.logsUsable && viewHostSilent);
  const readEvents = !(ctx.logsUsable && hostDebugSilent);

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
      // A call 0.3.0 HELD for a module that was not reachable, and that was
      // never dispatched, is one the app made and that did not happen: it
      // cannot satisfy `calls:`, it does break `no_calls:`, and it is named
      // for what it is when `calls:` lists what it saw instead.
      const observed = callsIn(ctx.window).filter((c) => !ctx.ignoreCalls.some((i) => matchesCall(callName(c), i)));
      const dispatched = observed.filter((c) => !c.held).map(callName);
      const seen = observed.map(callName);
      const described = observed.map(describeCall);
      for (const want of readCalls ? wantCalls : []) {
        const hit = dispatched.some((o) => matchesCall(o, want));
        checks.push({
          kind: "calls",
          description: `calls ${want}`,
          verdict: hit ? "pass" : "fail",
          ...(hit ? {} : { detail: described.length ? `saw instead: ${uniq(described).join(", ")}` : "no backend calls at all" }),
        });
      }
      for (const want of readCalls ? wantNoCalls : []) {
        const hit = seen.some((o) => matchesCall(o, want));
        checks.push({
          kind: "noCalls",
          description: `does not call ${want}`,
          verdict: hit ? "fail" : "pass",
          ...(hit ? { detail: "it was called" } : {}),
        });
      }
      const events = ctx.window.filter((p) => p.signal?.kind === "event_emitted").map((p) => p.signal!.method!);
      for (const want of readEvents ? wantEvents : []) {
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
  // answered, or the bridge's reply window (20 s on stock Basecamp) expired. It
  // does NOT catch a call that reached the module and came back with an error,
  // because LogosQmlBridge::callModule returns those to QML as a JSON payload
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
    if (blamed.length === 0 && viewHostSilent && (wantCalls.length > 0 || expect.callsSucceed === true)) {
      // Nothing failed that can be seen, and the app's own calls cannot be:
      // a pass here would be a claim about evidence nobody read. A failure
      // that IS visible is still reported below, whatever the channel.
      checks.push({
        kind: "callsSucceed",
        description: "no failed or timed-out backend calls",
        verdict: "inconclusive",
        detail: `${ctx.viewModuleApp}'s ui-host output never reached this run, so its calls' failures cannot be seen. ${VIEW_HOST_REMEDY}`,
      });
    } else if (blamed.length > 0 || wantCalls.length > 0) {
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
  const apps = attributedApps(ctx);
  if (expect.noErrors !== false && ctx.logsUsable) {
    // A view module's ui-host crashing is its app's error as surely as a
    // TypeError is: the bridge names the module (both 0.2.2 and 0.3.0).
    const errors = ctx.window.filter(
      (p) => (p.signal?.kind === "qml_error" || p.signal?.kind === "view_module_crashed") && countsAgainst(p, apps),
    );
    checks.push({
      kind: "noErrors",
      description: apps.length ? `no new QML errors in ${apps.join(", ")}` : "no new QML errors",
      verdict: errors.length === 0 ? "pass" : "fail",
      ...(errors.length === 0 ? {} : { detail: describeDiagnostics(errors, apps) }),
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
    const warnings = ctx.window.filter((p) => p.signal?.kind === "qml_warning" && countsAgainst(p, apps));
    checks.push({
      kind: "noWarnings",
      description: apps.length ? `no new QML warnings in ${apps.join(", ")}` : "no new QML warnings",
      verdict: warnings.length === 0 ? "pass" : "fail",
      ...(warnings.length === 0 ? {} : { detail: describeDiagnostics(warnings, apps) }),
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
 * A `state:` entry aimed at another app with `in:`.
 *
 * The three ways it cannot be evaluated are three different answers. An app
 * that was staged but not opened yet is INCONCLUSIVE: the expression may well
 * hold, and nothing looked. A name that no staged UI app answers to is a FAIL,
 * because the spec is wrong and waiting cannot fix it.
 */
async function stateIn(ctx: AssertContext, expr: string, target: string): Promise<Check> {
  const where: InTarget = ctx.rootFor
    ? await ctx.rootFor(target)
    : { kind: "not-staged", detail: `this run cannot evaluate in another app, so "${target}" cannot be reached` };
  const module = where.kind === "not-staged" ? target : where.module;
  const description = `state ${JSON.stringify(expr)} in ${module}`;
  if (where.kind === "not-open" || where.kind === "no-root") {
    return { kind: "state", description, verdict: "inconclusive", detail: where.detail, in: module };
  }
  if (where.kind === "not-staged") {
    return { kind: "state", description, verdict: "fail", detail: where.detail, in: module };
  }
  try {
    const res = await ctx.inspector.evaluate(expr, where.rootId);
    const truthy = Boolean(res.result) && !res.undefined;
    const why = truthy ? "" : await explainFalse(ctx.inspector, expr, where.rootId);
    return {
      kind: "state",
      description,
      verdict: truthy ? "pass" : "fail",
      ...(truthy ? {} : { detail: `evaluated to ${JSON.stringify(res.result)}${why}` }),
      in: module,
    };
  } catch (err) {
    return { kind: "state", description, verdict: "fail", detail: (err as Error).message, in: module };
  }
}

/** The apps whose diagnostics count. See AssertContext.appNames. */
function attributedApps(ctx: AssertContext): string[] {
  if (ctx.appNames) return [...new Set(ctx.appNames)];
  return ctx.appName ? [ctx.appName] : [];
}

function countsAgainst(p: ParsedLine, apps: string[]): boolean {
  if (apps.length === 0) return true;
  const who = attributeTo(p);
  return who !== undefined && apps.includes(who);
}

/**
 * The first few diagnostics, each naming its app once more than one counts.
 *
 * A single-app step reads exactly as it always did. With two apps open, an
 * error in the wallet during a click in the dApp is only actionable if it says
 * which of the two threw.
 */
function describeDiagnostics(lines: ParsedLine[], apps: string[]): string {
  return lines
    .slice(0, 3)
    .map((p) => (apps.length > 1 ? `${attributeTo(p) ?? "?"}: ${p.message}` : p.message))
    .join("\n      ");
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

function describeFailures(
  failures: Array<{ module?: string; method: string; confident: boolean; alternatives: string[]; detail?: string }>,
): string {
  const lines = failures.map((f) => {
    const name = `${f.module ?? "?"}.${f.method}`;
    // A failure the log explains (a module never reached, a call held and
    // never dispatched, a token exchange that timed out) says so.
    if (f.confident && f.detail === "during token exchange") return `${name} failed or timed out during its token exchange`;
    if (f.confident && f.detail) return `${name} failed: ${f.detail}`;
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
  // The caveat is about transport failures, which are paired by position. One
  // that names its module (a replica never acquired, a held call) is not.
  const positional = failures.some((f) => !f.detail || f.detail === "during token exchange");
  return (
    lines.join("\n      ") +
    (positional
      ? `\n      (the failure line names neither module nor method; it is matched to the transport ` +
        `line before it, so with overlapping calls the attribution is a best guess)`
      : "")
  );
}

/**
 * How much of a file `contains:` will read.
 *
 * An app that appends to a log has no upper bound, and reading a gigabyte into
 * a string does not throw — it takes the runner's process with it, and the
 * whole report with that, which is the outcome the try/catch around pollChecks
 * exists to prevent. Refusing to answer is the honest alternative.
 */
const MAX_CONTAINS_BYTES = 8 * 1024 * 1024;

/** `file: "a/b"` means `file: { path: "a/b" }`, the way a bare string is a selector. */
export function toFileExpect(input: FileInput): FileExpect {
  return typeof input === "string" ? { path: input } : input;
}

/**
 * Where on disk a `file:` expectation points, or why it cannot be answered.
 *
 * A relative path resolves against the $HOME this run gave the app, which is
 * the only spelling that means the same thing in a sandboxed run and under
 * --real-home. An absolute one is taken literally, but must still land in a
 * directory the run owns: that $HOME, or the user-dir it staged, where Basecamp
 * keeps module_data. Anywhere else the answer is about the developer's machine
 * rather than about the app — /etc/passwd exists on every CI runner, and a
 * check that merely stat'ed it would report a green about a file nothing here
 * touched.
 *
 * Deliberately no realpath(). The sandbox symlinks the tool directories
 * (.local/bin, .nix-profile, …) through to the real ones so apps can shell out,
 * and resolving links would refuse exactly the paths the sandbox chose to
 * share. The README says what that means instead of implying a guarantee a
 * symlink cannot give.
 */
export function resolveFilePath(
  p: string,
  home: string | null,
  userDir: string | null,
): { path: string } | { why: string } {
  if (!home) {
    return {
      why:
        "this run did not choose the app's $HOME, so a `file:` path has nothing to resolve against — " +
        "attach mode drives a process sitometres did not start. Let it launch the app instead.",
    };
  }
  const resolved = path.resolve(home, p);
  const homeRoot = path.resolve(home);
  const dirRoot = userDir === null ? null : path.resolve(userDir);
  // The same containment test unpackLgx uses on tar entry names: resolve first,
  // then ask where you landed, because "../../escape" is a question about the
  // destination and not about the spelling.
  const insideHome = resolved === homeRoot || resolved.startsWith(homeRoot + path.sep);
  const insideUserDir =
    dirRoot !== null && (resolved === dirRoot || resolved.startsWith(dirRoot + path.sep));
  if (!insideHome && !insideUserDir) {
    return {
      why:
        `${resolved} is outside this run's $HOME (${homeRoot})` +
        (dirRoot === null ? "" : ` and its user-dir (${dirRoot})`) +
        `, so nothing there can be attributed to the app under test. Write the path relative to $HOME.`,
    };
  }
  return { path: resolved };
}

/**
 * What IS in the directory, when the file is not.
 *
 * The job nearestLabels does for `text:`. "No such file" is true and useless;
 * the cause is nearly always a name one character out, or a directory the app
 * never created at all.
 */
function nearestFiles(p: string): string {
  const dir = path.dirname(p);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? `neither it nor its directory ${dir} exists`
      : `its directory ${dir} could not be listed (${code})`;
  }
  if (entries.length === 0) return `${dir} exists and is empty`;
  return (
    `${dir} holds: ${entries.slice(0, 5).map((e) => JSON.stringify(e)).join(", ")}` +
    (entries.length > 5 ? `, and ${entries.length - 5} more` : "")
  );
}

/**
 * Did the app leave this file behind?
 *
 * Three outcomes, and the third is why this is not fs.existsSync. An absent
 * file is a FAIL: absence is exactly the answer the spec asked for. A path we
 * are not allowed to look at is INCONCLUSIVE — "cannot read" is not evidence of
 * absence, and grading it either way would claim more than the run proved.
 *
 * It reports "exists", not "wrote": a file that was already there passes, and
 * nothing here can tell the difference. The same honesty as `text:`, which says
 * "sees" rather than "rendered".
 */
function fileCheck(ctx: AssertContext, want: FileExpect): Check {
  const description =
    want.contains === undefined
      ? `file ${JSON.stringify(want.path)} exists`
      : `file ${JSON.stringify(want.path)} contains ${JSON.stringify(want.contains)}`;
  const where = resolveFilePath(want.path, ctx.appHome, ctx.userDirRoot);
  if ("why" in where) return { kind: "file", description, verdict: "inconclusive", detail: where.why };

  let st: fs.Stats;
  try {
    st = fs.statSync(where.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT and ENOTDIR are the two that mean "it is not there", which is the
    // question. Every other errno — EACCES on the file or on a directory above
    // it, ELOOP, EIO, ENAMETOOLONG — means the question could not be put.
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        kind: "file",
        description,
        verdict: "fail",
        detail: `${where.path} does not exist — ${nearestFiles(where.path)}`,
      };
    }
    return {
      kind: "file",
      description,
      verdict: "inconclusive",
      detail:
        `${where.path} could not be read (${code ?? (err as Error).message}), ` +
        `which is not evidence that it is absent`,
    };
  }
  if (!st.isFile()) {
    return {
      kind: "file",
      description,
      verdict: "fail",
      detail: `${where.path} exists but is a ${st.isDirectory() ? "directory" : "special file"}`,
    };
  }
  if (want.contains === undefined) return { kind: "file", description, verdict: "pass" };
  if (st.size > MAX_CONTAINS_BYTES) {
    return {
      kind: "file",
      description,
      verdict: "inconclusive",
      detail:
        `${where.path} is ${Math.round(st.size / 1024 / 1024)} MiB; \`contains\` reads the file into ` +
        `memory and stops above ${MAX_CONTAINS_BYTES / 1024 / 1024} MiB`,
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(where.path, "utf8");
  } catch (err) {
    return {
      kind: "file",
      description,
      verdict: "inconclusive",
      detail: `${where.path} exists but could not be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`,
    };
  }
  const hit = text.includes(want.contains);
  return {
    kind: "file",
    description,
    verdict: hit ? "pass" : "fail",
    ...(hit ? {} : { detail: `${where.path} exists (${st.size} bytes) but does not contain it` }),
  };
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
