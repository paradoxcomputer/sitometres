// ---------------------------------------------------------------------------
// Every time budget a run spends, and where each one comes from.
//
// Nothing here is a limit. Each value is a default that a spec, a step or a
// flag can replace with any duration at all, "none" included. The one thing
// this file adds that no caller can opt out of is the no-timer path: Node's
// setTimeout silently turns any delay of 2^31 ms or more into about 1 ms
// (verified on v22.20.0), so a user who asked for more time than that would
// get almost none. Such a delay, and an unlimited one, arms no timer at all.
//
// The defaults that matter are derived from the Logos bridge's reply window
// rather than written down as numbers. A synchronous `logos.callModule` blocks
// the GUI thread until the bridge gives up, and the inspector is served from
// that same thread, so an inspector deadline at or below the bridge window
// fires first and the bridge's own error can never be reported. The window is
// 20 s on stock Basecamp; a build that raises it is followed automatically,
// because every synchronous dispatch line in the log carries it as
// `timeout: N` (see learnCallWindow in ./logs/classify.ts).
// ---------------------------------------------------------------------------

/** The largest delay Node's setTimeout honours. Above it the timer fires after ~1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** The bridge's reply window on stock Basecamp: logos-protocol's `Timeout()` default. */
export const DEFAULT_CALL_WINDOW_MS = 20_000;

/**
 * How far an inspector command's deadline sits beyond the bridge window.
 *
 * Long enough for the bridge's own timeout to be logged and returned to QML,
 * and for the GUI thread to answer the command queued behind it.
 */
export const COMMAND_MARGIN_MS = 10_000;

/** A step's budget when nothing says otherwise, while the bridge window is 20 s or less. */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;

/** Opening an app when nothing says otherwise. */
export const DEFAULT_OPEN_TIMEOUT_MS = 120_000;

/** Startup readiness for a Basecamp this run launched. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

/** Startup readiness when attaching to one that is already running. */
export const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;

/** How long a `run` step watches before accepting a clean negative expectation. */
export const DEFAULT_RUN_SETTLE_MS = 1_000;

/** How long a crawl watches each click. */
export const DEFAULT_SMOKE_SETTLE_MS = 2_500;

/** The pause for an app's first paint once its dock exists. */
export const DEFAULT_OPEN_SETTLE_MS = 1_200;

/**
 * Whether a budget needs a timer at all.
 *
 * False for "none" (Infinity) and for anything Node cannot time: arming a
 * timer for those would end the wait after about a millisecond, the opposite
 * of what was asked.
 */
export function hasDeadline(ms: number): boolean {
  // Written as a negation so that NaN, which only a library caller could pass,
  // keeps the deadline it always had (Node fires it at once) rather than
  // silently becoming "wait forever".
  return !(ms >= MAX_TIMER_MS);
}

/**
 * setTimeout, except that a budget without a deadline arms nothing.
 *
 * Returns null in that case, so the caller's clearTimeout has nothing to do.
 */
export function timerFor(ms: number, fire: () => void): NodeJS.Timeout | null {
  return hasDeadline(ms) ? setTimeout(fire, Math.max(0, ms)) : null;
}

/** A budget for a message: "30000ms", or "no deadline". */
export function describeBudget(ms: number): string {
  return hasDeadline(ms) ? `${Math.round(ms)}ms` : "no deadline";
}

/** The same, in the seconds a person reads: "30s", "1.5s", or "no deadline". */
export function describeSeconds(ms: number): string {
  if (!hasDeadline(ms)) return "no deadline";
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : Number(s.toFixed(1))}s`;
}

/**
 * An inspector command's deadline when nothing more specific was chosen.
 *
 * Strictly beyond the bridge window, for the reason at the top of this file.
 * An unlimited window gives an unlimited deadline.
 */
export function commandTimeoutFor(callWindowMs: number): number {
  return hasDeadline(callWindowMs) ? callWindowMs + COMMAND_MARGIN_MS : Infinity;
}

/**
 * A step's budget when neither the step, the spec nor the command line set one.
 *
 * 30 s with a stock 20 s bridge window, exactly as it always was. Raised with
 * the window, because a step that closes before the bridge gives up cannot see
 * the call it made time out.
 */
export function defaultStepTimeout(callWindowMs: number): number {
  return Math.max(DEFAULT_STEP_TIMEOUT_MS, commandTimeoutFor(callWindowMs));
}

/**
 * The time budgets a command line can set, in milliseconds.
 *
 * Infinity means "none". Absent means the flag was not given. Carried from the
 * CLI through boot to every runner, setup profiles included, so a profile
 * inherits what the command line asked for while its own header and steps
 * still win.
 */
export interface TimeoutFlags {
  /** --timeout: startup readiness. Also the open budget when nothing more specific is set. */
  timeoutMs?: number;
  /** --step-timeout: a step's budget when neither the step nor its spec sets one. */
  stepTimeoutMs?: number;
  /** --command-timeout: the longest any one inspector command may block. */
  commandTimeoutMs?: number;
  /** --call-timeout: the bridge's reply window, when the log cannot say. */
  callTimeoutMs?: number;
  /** --open-timeout: the budget for opening an app, honoured exactly as given. */
  openTimeoutMs?: number;
}

/** Just the timeout flags out of a larger options object, dropping the ones not given. */
export function timeoutFlagsOf(o: TimeoutFlags): TimeoutFlags {
  const out: TimeoutFlags = {};
  if (o.timeoutMs !== undefined) out.timeoutMs = o.timeoutMs;
  if (o.stepTimeoutMs !== undefined) out.stepTimeoutMs = o.stepTimeoutMs;
  if (o.commandTimeoutMs !== undefined) out.commandTimeoutMs = o.commandTimeoutMs;
  if (o.callTimeoutMs !== undefined) out.callTimeoutMs = o.callTimeoutMs;
  if (o.openTimeoutMs !== undefined) out.openTimeoutMs = o.openTimeoutMs;
  return out;
}

/**
 * The open budget for a command that opens its app outside any spec step.
 *
 * --open-timeout is honoured exactly as given. --timeout still reaches the
 * open, as it always has, but it was written for startup, so it is treated
 * like the default: the open's floor applies to it (see openApp).
 */
export function openBudgetFrom(flags: TimeoutFlags): { timeoutMs?: number; explicit: boolean } {
  if (flags.openTimeoutMs !== undefined) return { timeoutMs: flags.openTimeoutMs, explicit: true };
  if (flags.timeoutMs !== undefined) return { timeoutMs: flags.timeoutMs, explicit: false };
  return { explicit: false };
}
