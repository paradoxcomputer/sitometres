// ---------------------------------------------------------------------------
// Did the thing the click started actually work?
//
// "Something changed" is a change detector, not a success check, and the two
// are easy to confuse: clicking Send and watching the screen repaint tells you
// nothing about whether a token moved.
//
// What can actually be known, and what cannot:
//
//   provable failure   the transport reported a failed/timed-out call, the app
//                      threw a QML error, or the app itself rendered an error.
//                      LogosQmlBridge hands module errors back to QML as a
//                      payload and logs NOTHING, so the rendered text is the
//                      only place a bridge-level failure is visible at all.
//   provable dispatch  a backend call was made — the log proves that much.
//   provable success   NOT generically. A module returning {"ok":true} looks
//                      identical, in the log, to one returning {"error":...}.
//
// So a crawl can be trusted to catch failures and to say when it cannot tell.
// For "the transfer really settled", the outcome has to be named by a spec —
// `state:` against the app's own model, or the confirmation text it renders.
// This module classifies; it never guesses upward.
// ---------------------------------------------------------------------------

import { attributeTo, callName, callsIn, pairFailures, type PairedFailure, UNATTRIBUTED, type ParsedLine } from "../logs/classify.js";
import { matchesCall, suppressedBy } from "./assert.js";

export type Outcome = "failed" | "worked" | "ran" | "unclear" | "nothing";

export interface OutcomeReport {
  /**
   * Failures seen in this window whose attribution is a guess.
   *
   * Kept apart from `outcome` deliberately. That a call failed is CERTAIN;
   * which control caused it is not. So the control is not accused — the
   * outcome stays `unclear` — but the caller must still count these, or the
   * run reports success while a backend call failed. Grading them `unclear`
   * and counting them nowhere is how the crawl came to exit 0 on a broken app.
   */
  hedgedFailures: string[];
  outcome: Outcome;
  /** One line per piece of evidence, in the order it was found. */
  evidence: string[];
  /** Backend calls seen in the window. */
  calls: string[];
  /** Calls the transport reported as failed or timed out. */
  failedCalls: string[];
  /** QML errors attributed to the app under test. */
  errors: string[];
  /** Text the app rendered that reads as a failure. */
  reportedErrors: string[];
  /** Text the app rendered that reads as a confirmation. */
  reportedSuccess: string[];
}

/**
 * Words an app uses when an operation did not work.
 *
 * Matched against text that appeared AFTER the click, so a static label like
 * "Install failed. Please try again." sitting in a hidden dialog template does
 * not count — only text the action actually surfaced.
 */
const FAILURE_WORDS =
  /\b(error|failed|failure|invalid|insufficient|denied|rejected|refused|unavailable|not connected|unable|cannot|couldn't|could not|timed out|timeout|try again|wrong|incorrect|missing)\b/i;

/** Words an app uses when an operation did work. */
const SUCCESS_WORDS =
  /\b(sent|success|succeeded|confirmed|complete|completed|done|copied|saved|created|added|updated|approved|unlocked|connected|settled|broadcast|submitted)\b|✓|✔/i;

export interface OutcomeInput {
  /** Parsed log lines produced between the click and now. */
  window: ParsedLine[];
  /** Labels visible after the click that were not visible before. */
  newLabels: string[];
  /**
   * Newly visible text that is the app REPORTING something — prose that
   * resolves to no control.
   *
   * Only this may drive `worked` or `failed`. A control's own name is not the
   * app reporting, and text in a hand-rolled card is indistinguishable from
   * either, so neither is included; see UiSnapshot.labelsWithRole.
   */
  newMessageLabels?: string[];
  /** Module name of the app under test, for error attribution. */
  appName: string | null;
  /** Call names to ignore, e.g. a polling loop. */
  ignoreCalls?: string[];
  /** False when the build's logs carry no call evidence. */
  logsUsable: boolean;
  /**
   * Failures already paired and attributed to THIS window by the caller.
   *
   * Pairing inside a per-click window is wrong whenever a reply outlives the
   * window that dispatched it — which, with a 2.5 s crawl settle and a 20 s
   * transport timeout, is every timeout. The failure line lands in a later
   * click's window, that window contains that click's own healthy dispatch, and
   * pairing confidently names it as the victim. Reproduced: a click whose call
   * succeeded graded `failed` with the name of the call that succeeded.
   *
   * A caller that can see the whole run pairs once and hands each window only
   * the failures whose dispatch belongs to it. Left undefined, the window is
   * paired on its own, which is right when the window outlives the transport.
   */
  failures?: PairedFailure[];
}

export function classifyOutcome(input: OutcomeInput): OutcomeReport {
  const ignore = input.ignoreCalls ?? [];
  const calls = [
    ...new Set(
      callsIn(input.window)
        .map(callName)
        .filter((n) => !ignore.some((i) => matchesCall(n, i))),
    ),
  ];

  // Two traps here, both of which turned a background poll into a FAILED click.
  //
  // The module is only known when a call_started line for it fell inside the
  // same window; a poll that began before the cursor pairs as "?.pendingRequests",
  // which no fully-qualified ignore entry can ever match. And plain string
  // equality ignored the bare-method and "module.*" forms that the call filter
  // accepts, so the two lists disagreed about what counted as noise.
  const attributed = [...(input.failures ?? [...pairFailures(input.window).values()])]
    .filter((f) => !suppressedBy(f, ignore));
  /**
   * Failures this click can actually be blamed for.
   *
   * A hedged pairing does NOT accuse a control. The failure line names neither
   * module nor method, so it is matched to the nearest preceding dispatch — and
   * when several calls were in flight, the nearest one is often somebody else's.
   * Reproduced: a click whose own call succeeded was graded `failed` and the
   * successful call was named as the victim. Grading a control `failed` on a
   * guess is exactly the overstatement this tool exists not to make. Hedged
   * failures still appear as evidence, and still stop the click reading as
   * clean — see the ladder below, where they land on `unclear`.
   */
  const confidentFailures = attributed.filter((f) => f.confident);
  const failedCalls = attributed
    .map((f) =>
      f.method === UNATTRIBUTED
        ? "a call failed, unattributable to any click"
        : f.confident
          ? `${f.module ?? "?"}.${f.method}`
          : `${f.module ?? "?"}.${f.method}?`,
    );

  const errors = input.window
    .filter((p) => p.signal?.kind === "qml_error")
    .filter((p) => !input.appName || attributeTo(p) === input.appName)
    .map((p) => p.message);

  const consoleLines = input.window
    .filter((p) => p.signal?.kind === "qml_console")
    .map((p) => p.signal!.detail ?? "");

  // Console output is unambiguous — the app wrote it — so it always counts.
  // On-screen text counts only when it is prose. When the caller does not
  // classify (a spec run, which asserts explicitly rather than guessing), fall
  // back to every label, preserving the old behaviour for that path.
  const surfaced = [...(input.newMessageLabels ?? input.newLabels), ...consoleLines];
  const reportedErrors = surfaced.filter((t) => FAILURE_WORDS.test(t));
  const reportedSuccess = surfaced.filter((t) => SUCCESS_WORDS.test(t) && !FAILURE_WORDS.test(t));

  const evidence: string[] = [];
  for (const f of failedCalls) evidence.push(`${f} failed or timed out`);
  for (const e of errors.slice(0, 2)) evidence.push(`QML error: ${e}`);
  for (const t of reportedErrors.slice(0, 2)) evidence.push(`the app reported: ${JSON.stringify(trim(t))}`);
  for (const t of reportedSuccess.slice(0, 2)) evidence.push(`the app confirmed: ${JSON.stringify(trim(t))}`);
  if (calls.length) evidence.push(`called ${calls.join(", ")}`);

  let outcome: Outcome;
  if (confidentFailures.length > 0 || errors.length > 0 || reportedErrors.length > 0) {
    outcome = "failed";
  } else if (failedCalls.length > 0) {
    // Something failed near this click and the attribution is a guess. Saying
    // `failed` would accuse this control; saying nothing would hide a real
    // failure. `unclear` is the honest middle, and it is reported as skipped
    // rather than passed in the machine output, so a --strict gate still fails.
    outcome = "unclear";
  } else if (reportedSuccess.length > 0) {
    // The app said so itself. Still only as good as its own reporting, but it
    // is the strongest signal available without a spec naming the outcome.
    outcome = "worked";
  } else if (calls.length > 0) {
    // A call was made and nothing complained. That is dispatch, not success —
    // the module's answer is invisible from here.
    outcome = "ran";
  } else if (input.newLabels.length > 0) {
    outcome = "unclear";
  } else {
    outcome = "nothing";
  }

  // A quiet build cannot distinguish "no call" from "call not logged", so a
  // UI-only change must not be reported as if the backend stayed idle.
  if (!input.logsUsable && (outcome === "unclear" || outcome === "nothing")) {
    outcome = "unclear";
  }

  const hedgedFailures = attributed
    .filter((f) => !f.confident)
    .map((f) => (f.method === UNATTRIBUTED ? "a call" : `${f.module ?? "?"}.${f.method}`));
  return { outcome, evidence, calls, failedCalls, errors, reportedErrors, reportedSuccess, hedgedFailures };
}

/** How the verdict should read in a report, in plain words. */
export function describeOutcome(o: Outcome): string {
  switch (o) {
    case "failed": return "failed";
    case "worked": return "worked";
    case "ran": return "ran (unconfirmed)";
    case "unclear": return "unclear";
    // Not "no effect": the evidence is "no call was logged and no new text appeared", which
    // is a statement about what this crawl can see, not about what the control does. It reads
    // identically for a dead handler, a popup rendered into an overlay, a value-only update,
    // and navigation to a screen that reuses the same labels — three of which are working
    // controls. Report the observation; let the reader draw the conclusion.
    case "nothing": return "no change seen";
  }
}

function trim(s: string): string {
  return s.length <= 60 ? s : s.slice(0, 59) + "…";
}
