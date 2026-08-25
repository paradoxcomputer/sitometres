// ---------------------------------------------------------------------------
// Running a spec against a live Basecamp session.
//
// The shape of every step is the same:
//
//   mark the log cursor  ->  perform the gesture  ->  poll the expectations
//
// Polling matters because clicks are POSTED, not sent: when findAndClick or
// click returns, the mouse events are merely queued and no handler has run.
// So an expectation is retried until it holds or the step's timeout expires,
// and the step's evidence window is every log line that arrived inside the
// bracket. That window is also what keeps a chatty app honest — medusa_ui's
// 800 ms poll accounts for well over half of all call lines in a normal
// session, and only the delta since the click is attributable to it.
// ---------------------------------------------------------------------------

import { sleep } from "../inspector/client.js";
import type { LogCursor } from "../logs/buffer.js";
import { callName, callsIn, explainOpenFailure, pairFailures, parseLine } from "../logs/classify.js";
import type { Session } from "../app/lifecycle.js";
import { type Expect, parseDuration, type Spec, type Step } from "../spec/schema.js";
import { type ActionContext, displayText, doClick, doEval, doSet, doType, snapshot } from "./actions.js";
import { allMonotone, type Check, runChecks, settled, type Verdict, verdictOf } from "./assert.js";
import { openApp, openOptionsFor, OpenError } from "./open.js";
import { type AppManifest, uiLabel } from "../app/manifest.js";
import { status } from "../report/status.js";
import { SelectorError } from "./selector.js";
import type { UiSnapshot } from "./snapshot.js";
import { unlockWallet, type WalletProvider } from "../app/wallet.js";
import { createDebugREPL, type DebugContext, type DebugCallbacks } from "./debug.js";

type DebugPauseFn = () => Promise<"next" | "continue" | "quit">;

/**
 * Does this step's comment mark it as a breakpoint?
 *
 * Exported because nothing tested it: no spec in `tests/` ever set a step
 * comment, though two archived tasks recorded that coverage as done.
 */
export function isBreakpointComment(comment: string | undefined): boolean {
  return comment !== undefined && /\bbreakpoints?\b/i.test(comment);
}

export interface StepResult {
  index: number;
  name: string;
  action: string;
  verdict: Verdict;
  durationMs: number;
  checks: Check[];
  /** Backend calls seen during the step, whether or not they were asserted. */
  callsObserved: string[];
  /** Populated when the step blew up rather than merely failing a check. */
  error?: string;
  screenshot?: string;
}

export interface RunResult {
  steps: StepResult[];
  verdict: Verdict;
  durationMs: number;
}

export interface RunnerOptions {
  session: Session;
  spec: Spec;
  /** Module name of the app under test. */
  appName: string | null;
  /** Manifest of the app under test, for resolving `open:` to its two names. */
  manifest?: AppManifest;
  /** The discovered app, so the open hint can describe its staged directory. */
  app?: { manifest: { view?: string }; slot: string };
  /** Root of the staged user-dir, for the same reason. */
  userDirRoot?: string;
  /**
   * How long to wait for an app to open. Separate from a step's timeout:
   * opening is not the step's work, and a short step budget used to make the
   * open unpassable.
   */
  openTimeoutMs?: number;
  logsUsable: boolean;
  /** Where screenshots go. */
  artifactDir?: string;
  /**
   * Minimum time to observe the app after a gesture before accepting a clean
   * result that includes a negative expectation. See pollChecks().
   */
  settleMs?: number;
  /**
   * Unlock the wallet as soon as the app is open, when a password was given.
   *
   * Unlocking needs the app's QML root, so it cannot happen before the open
   * step; doing it here means every later step sees an unlocked wallet instead
   * of failing against a lock screen and looking like an app bug.
   */
  walletUnlock?: { provider: WalletProvider; password: string };
  onStep?: (result: StepResult) => void;
  /**
   * Where a line about the run itself goes — as opposed to a step's result.
   *
   * A parameter because the runner does not know whose stdout it is writing to.
   * The "later steps were not attempted" note went straight to console.log, and
   * under `inspect --json` — which runs a setup profile through this very
   * runner — it landed in the middle of the JSON document and made the payload
   * unparseable. Exactly the defect the quiet narration exists to prevent,
   * reintroduced one layer down.
   */
  onNote?: (line: string) => void;
  /** Whether to continue execution without pausing (after 'continue' command) */
  continueExecution?: boolean;
  /**
   * Run once, as soon as the app is open and any wallet is unlocked.
   *
   * This is where a setup profile belongs for `run`: after the spec's `open:`
   * has established the scope, before any of its assertions. A callback rather
   * than a Spec so the runner keeps no dependency on profile discovery — and so
   * the profile's own nested runner cannot recurse into another one.
   *
   * A profile that did not complete becomes a failing check on the open step,
   * because that is the step during which the gate was supposed to be walked,
   * and everything the spec asserts afterwards is about the wrong screen.
   */
  onOpened?: () => Promise<{ failed: string | null }>;
}

export class Runner {
  private scopeId: string | null = null;
  private qmlRootId: string | null = null;
  private readonly defaultTimeout: number;
  private readonly settleMs: number;
  /** Log cursor marking the start of the step in progress, for debug inspection. */
  private stepCursor: LogCursor | null = null;
  /** Checks produced by a wait_for action, awaiting attachment to its step. */
  private pendingChecks: Check[] | null = null;
  /** Checks an action established about itself, for the step in progress. */
  private actionChecks: Check[] = [];
  /**
   * Steps finished so far, readable after run() throws.
   *
   * A click that kills the app used to destroy the whole report: the report was
   * built from run()'s return value, so there was nothing to write and CI said
   * "no test results" instead of "step 2 crashed the app".
   */
  readonly completed: StepResult[] = [];
  /** Debug REPL pause function, when debug mode is active */
  private debugPause: DebugPauseFn | null = null;
  /** Whether to skip further pause points (after 'continue' command) */
  private skipPauses = false;
  /** True when the spec marks any step as a breakpoint. See shouldPauseBefore. */
  private readonly hasSpecBreakpoints: boolean;
  /** A spec may `open:` more than once; the setup profile runs after the first. */
  private openedHookRan = false;

  constructor(private readonly opts: RunnerOptions) {
    // Above the transport's own 20 s reply timeout, deliberately: at 15 s a
    // call that timed out could not be seen to have timed out, because the
    // step's evidence window had already closed before the failure was logged.
    this.defaultTimeout = parseDuration(opts.spec.timeout, 30_000);
    this.settleMs = opts.settleMs ?? 1_000;
    this.hasSpecBreakpoints = opts.spec.steps.some((s) => isBreakpointComment(s.comment));

    // Initialize debug mode if session has debug context
    if (this.opts.session.debug) {
      this.debugPause = this.createDebugPause();
    }
  }

  /**
   * Create the debug pause function with appropriate callbacks.
   */
  private createDebugPause(): DebugPauseFn {
    return createDebugREPL(this.opts.session.debug!, this.debugCallbacks());
  }

  /**
   * What the debug REPL can ask the run about.
   *
   * Separate from createDebugPause so it can be tested without a terminal: the
   * previous tests stubbed these with literals, which is why `state` calling
   * evaluate() with its arguments reversed and `logs` reading an empty window
   * both shipped.
   */
  debugCallbacks(): DebugCallbacks {
    const callbacks: DebugCallbacks = {
      getState: async () => {
        if (!this.qmlRootId) return "No QML root available (app not opened yet)";
        try {
          // evaluate(expression, objectId) — these were passed the wrong way
          // round, sending the object id AS the expression, so `state` could
          // never have worked. And the whole EvaluateResult envelope was
          // printed rather than its .result.
          const res = await this.opts.session.inspector.evaluate("JSON.stringify(this)", this.qmlRootId);
          const raw = typeof res.result === "string" ? res.result : JSON.stringify(res.result);
          try {
            return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
          } catch {
            return raw;
          }
        } catch (err) {
          return `Error getting state: ${(err as Error).message}`;
        }
      },
      getLogs: async () => {
        // mark() returns a cursor just PAST the last line, so slicing from a
        // cursor taken here is empty by construction: this always said "none",
        // including when paused on a failure caused by the calls it hid. The
        // step's own cursor is the window the user is asking about.
        const from = this.stepCursor ?? 0;
        const window = this.opts.session.logs.slice(from).map(parseLine);
        const calls = [...new Set(callsIn(window).map(callName))];
        const failures = [...pairFailures(window).values()];
        const errors = window.filter((p) => p.signal?.kind === "qml_error").map((p) => p.message);
        return [
          `Calls observed: ${calls.join(", ") || "none"}`,
          `Failed or timed out: ${failures.map((f) => `${f.module ?? "?"}.${f.method}`).join(", ") || "none"}`,
          `QML errors: ${errors.length ? "\n  " + errors.slice(0, 5).join("\n  ") : "none"}`,
        ].join("\n");
      },
      getUI: async () => {
        try {
          const snap = await snapshot(this.ctx);
          return JSON.stringify(snap, null, 2);
        } catch (err) {
          return `Error getting UI snapshot: ${(err as Error).message}`;
        }
      },
      nextStep: async () => {
        // Step execution continues after returning from pause
      },
      continueExecution: () => {
        this.skipPauses = true;
      },
      quit: async () => {
        // Deliberately a no-op: `handleCommand` turns "q" into the "quit"
        // action, and run() already knows what to do with it.
        //
        // This used to call process.exit(1) from inside the callback, which
        // skipped `run`'s finally — so a user who quit after seeing the failure
        // they were debugging got no summary and no --json/--junit for the
        // steps already graded. That is the "no test results" outcome
        // failure-reporting exists to prevent, and it made both of run()'s
        // `if (action === "quit")` branches dead code. Cleanup is unaffected:
        // the session is disposed by the caller's finally either way.
      },
    };
    return callbacks;
  }

  /**
   * Turn whatever the spec said into the module name and the sidebar label.
   *
   * Falls back to using the name for both when no manifest is available — an
   * --attach run has no discovered app — which is the old behaviour, and is
   * correct when the two names coincide.
   */
  private resolveAppName(name: string): { moduleName: string; label: string } {
    const m = this.opts.manifest;
    if (!m) return { moduleName: name, label: name };
    const label = uiLabel(m);
    if (name === m.name || name === label) return { moduleName: m.name, label };
    throw new Error(
      `this spec opens "${name}", but the app here is "${m.name}"` +
        (label === m.name ? "" : ` (shown as "${label}")`) +
        `. Use either spelling.`,
    );
  }

  private get ctx(): ActionContext {
    return { inspector: this.opts.session.inspector, scopeId: this.scopeId };
  }

  async run(): Promise<RunResult> {
    const started = Date.now();
    const steps: StepResult[] = [];
    for (const [i, step] of this.opts.spec.steps.entries()) {
      // Update debug context before step execution
      if (this.opts.session.debug) {
        this.opts.session.debug.stepNumber = i + 1;
        this.opts.session.debug.stepDescription = step.name ?? describeAction(step);
        this.opts.session.debug.isBreakpoint = false;
        this.opts.session.debug.isFailure = false;
      }

      // Check for breakpoint
      const shouldBreak = this.shouldBreak(i + 1, step);
      if (shouldBreak && this.opts.session.debug) {
        this.opts.session.debug.isBreakpoint = true;
      }

      // Pause before this step?
      //
      // The gate used to read `session.debug?.active`, which is initialised
      // false and was only ever set to true INSIDE a pause — so it was exactly
      // `shouldBreak`, and plain --debug never paused at a step boundary at
      // all. `active` means "currently paused"; whether to pause is a question
      // about the flags, not about the pause that is not happening yet.
      if (this.debugPause && !this.skipPauses && this.shouldPauseBefore(shouldBreak)) {
        console.log(`\n  Pausing before step ${i + 1}: ${step.name ?? describeAction(step)}`);
        if (this.opts.session.debug) this.opts.session.debug.active = true;
        const action = await this.debugPause();
        if (this.opts.session.debug) this.opts.session.debug.active = false;
        if (action === "quit") {
          return this.stoppedAt(steps, i, started, "the run was quit from the debugger before this step");
        }
        if (action === "continue") {
          this.skipPauses = true;
        }
      }

      const result = await this.runStep(step, i);
      steps.push(result);
      this.completed.push(result);
      this.opts.onStep?.(result);

      // Auto-pause on failure
      if (result.verdict === "fail" && this.debugPause) {
        if (this.opts.session.debug) {
          this.opts.session.debug.isFailure = true;
          this.opts.session.debug.active = true; // Force activate on failure
        }
        console.log(`\n  Step failed: ${result.name}`);
        console.log(`  ${result.error || result.checks.filter(c => c.verdict === "fail").map(c => c.description).join(", ")}`);
        if (this.opts.session.debug) this.opts.session.debug.active = true;
        const action = await this.debugPause();
        if (this.opts.session.debug) this.opts.session.debug.active = false;
        if (action === "quit") {
          return this.stoppedAt(steps, i + 1, started, "the run was quit from the debugger after this step failed");
        }
        if (action === "continue") {
          this.skipPauses = true;
        }
      }

      // A step that could not even be performed invalidates everything after
      // it — the app is no longer in the state the spec assumes.
      if (result.error) {
        return this.stoppedAt(
          steps,
          i + 1,
          started,
          `step ${i + 1} could not be performed, so the app was no longer in the state this spec assumes`,
        );
      }
    }
    return {
      steps,
      verdict: verdictOf(steps.map((s) => ({ kind: "state", description: s.name, verdict: s.verdict }))),
      durationMs: Date.now() - started,
    };
  }

  /**
   * Finish a run that stopped early, accounting for the steps it never reached.
   *
   * Abandoning the rest of a spec is correct — the app is no longer where the
   * spec assumes — but recording them nowhere is not. The summary, the JSON and
   * the JUnit all described only the steps that executed, so a spec's test count
   * silently shrank: CI read `tests="2"` as a two-test suite that got smaller,
   * not as sixteen checks that were never attempted. They are inconclusive, not
   * absent — the same distinction the whole verdict system rests on.
   */
  private stoppedAt(done: StepResult[], from: number, started: number, why: string): RunResult {
    const rest = this.opts.spec.steps.slice(from).map((step, k) => ({
      index: from + k,
      name: step.name ?? describeAction(step),
      action: describeAction(step),
      verdict: "inconclusive" as const,
      durationMs: 0,
      checks: [{
        kind: "state" as const,
        description: "this step ran",
        verdict: "inconclusive" as const,
        detail: why,
      }],
      callsObserved: [] as string[],
    }));
    if (rest.length > 0) {
      (this.opts.onNote ?? ((l: string) => console.log(l)))(
        `\n  ${rest.length} later step(s) were not attempted: ${why}`,
      );
      this.completed.push(...rest);
    }
    const steps = [...done, ...rest];
    return {
      steps,
      verdict: verdictOf(steps.map((s) => ({ kind: "state", description: s.name, verdict: s.verdict }))),
      durationMs: Date.now() - started,
    };
  }

  /**
   * Check if we should break at this step.
   */
  /**
   * Whether to pause before a step.
   *
   * --debug alone pauses at every step boundary. --debug --breakpoint N pauses
   * only where asked: having named a step, the user does not want to be stopped
   * at every other one as well.
   */
  private shouldPauseBefore(isBreakpoint: boolean): boolean {
    const debug = this.opts.session.debug;
    if (!debug) return false;
    // A breakpoint FILTER is in force when the user said where to stop — with
    // --breakpoint N, or by marking steps in the spec itself. Only the CLI flag
    // used to count, so `comment: "# breakpoint"` — which README, SKILL and the
    // shipped example all present as the way to stop at the one step you care
    // about — changed nothing but the prompt prefix: under plain --debug every
    // step paused anyway, and without --breakpoint N nothing read the comment.
    if (debug.breakpointStep !== undefined || this.hasSpecBreakpoints) return isBreakpoint;
    return true;
  }

  private shouldBreak(stepNumber: number, step: Step): boolean {
    if (this.opts.session.debug?.breakpointStep === stepNumber) return true;
    return isBreakpointComment(step.comment);
  }

  private async runStep(step: Step, index: number): Promise<StepResult> {
    const started = Date.now();
    const timeout = parseDuration(step.timeout, this.defaultTimeout);
    const cursor = this.opts.session.logs.mark();
    this.stepCursor = cursor;
    this.actionChecks = [];
    let action = describeAction(step);
    status.set("Running", `step ${index + 1}/${this.opts.spec.steps.length}: ${step.name ?? action}`);

    const base: StepResult = {
      index,
      name: step.name ?? action,
      action,
      verdict: "pass",
      durationMs: 0,
      checks: [],
      callsObserved: [],
    };

    try {
      const performed = await this.perform(step, timeout);
      if (performed) action = performed;
      base.action = action;
    } catch (err) {
      // An OpenError's hint is the diagnosis — what was tried, whether the
      // plugin is even staged, what labels were on screen. Keeping only
      // .message left a `run` user with one bare line, while `smoke` printed
      // the whole thing. Better still is what the log already says: if it
      // records why the app would not load, that replaces the hint entirely.
      let extra = "";
      if (err instanceof OpenError) {
        const why = this.opts.appName
          ? explainOpenFailure(this.opts.session.logs.slice(cursor).map(parseLine), this.opts.appName)
          : null;
        if (why) extra = `\n  ${why.split("\n").join("\n  ")}`;
        else if (err.hint) extra = `\n  ${err.hint}`;
      }
      base.error = (err instanceof SelectorError ? err.message : (err as Error).message) + extra;
      base.verdict = "fail";
      base.durationMs = Date.now() - started;
      base.callsObserved = this.callsSince(cursor);
      return base;
    }

    if (this.pendingChecks) {
      base.checks = this.pendingChecks;
      this.pendingChecks = null;
    }
    if (this.actionChecks.length > 0) base.checks = [...base.checks, ...this.actionChecks];
    if (base.checks.length > 0) base.verdict = verdictOf(base.checks);
    const expect = step.expect;
    if (expect) {
      status.set("Running", `step ${index + 1}: checking ${describeExpect(expect)}`);
      // Adjust timeout for time spent in debug mode
      const adjustedTimeout = timeout - (Date.now() - started);
      try {
        base.checks = [...base.checks, ...(await this.pollChecks(expect, cursor, Math.max(adjustedTimeout, 1000)))];
        base.verdict = verdictOf(base.checks);
      } catch (err) {
        // Checking is where an app that died mid-step shows up: snapshot() hits
        // a dead socket and throws. This used to be outside any try, so it
        // escaped run() entirely and took the whole report with it — CI saw
        // "no test results" instead of "step N crashed the app".
        base.error = `the app stopped responding while checking this step: ${(err as Error).message}`;
        base.verdict = "fail";
      }
    }
    base.callsObserved = this.callsSince(cursor);
    base.durationMs = Date.now() - started;
    return base;
  }

  /** Execute the action. Returns a refined description when it learned one. */
  private async perform(step: Step, timeout: number): Promise<string | null> {
    if (step.open !== undefined) {
      await this.openApp(step.open, timeout);
      return `opened ${step.open}`;
    }
    if (step.click !== undefined) return (await doClick(this.ctx, step.click)).detail;
    if (step.type !== undefined) {
      const out = await doType(this.ctx, step.type);
      // An action that learned something must not have it discarded. `type:`
      // reads the field back, so it can know the text did not land — and that
      // used to survive only as prose while the step reported PASS with no
      // checks at all.
      if (out.check) this.actionChecks.push({ kind: "state", ...out.check });
      return out.detail;
    }
    if (step.set !== undefined) return (await doSet(this.ctx, step.set)).detail;
    if (step.eval !== undefined) return (await doEval(this.ctx, step.eval, this.qmlRootId)).detail;
    if (step.sleep !== undefined) {
      await sleep(parseDuration(step.sleep, 0));
      return null;
    }
    if (step.screenshot !== undefined) {
      await this.capture(step.screenshot);
      return `screenshot ${step.screenshot}`;
    }
    if (step.waitFor !== undefined) {
      const checks = await this.pollChecks(step.waitFor, this.opts.session.logs.mark(), timeout);
      const bad = checks.filter((c) => c.verdict === "fail");
      if (bad.length > 0) {
        throw new Error(
          `waitFor never came true within ${timeout}ms:\n  ` +
            bad.map((c) => `${c.description}${c.detail ? ` — ${c.detail}` : ""}`).join("\n  "),
        );
      }
      // Hand the checks back so the step reports what it actually waited on.
      // Dropping them meant a wait_for on unreadable log evidence returned PASS
      // in 38 ms with an empty check list — the exact opposite of waiting.
      this.pendingChecks = checks;
      return null;
    }
    return null;
  }

  /**
   * Click an app's sidebar entry and wait for its dock to exist.
   *
   * The dock is the scope handle for every later selector: WorkspaceArea gives
   * it objectName == the module name, and Basecamp hides docks rather than
   * destroying them, so without scoping a label like "Connect" could resolve
   * into a different plugin that happens to be open.
   *
   * `step.open` is resolved against the manifest, because an app has two names
   * and they play different roles: the sidebar shows `display_name`, the dock
   * is named after the module. Passing one string as both — which is what this
   * did — meant `open: "ZoneScan Lite"` waited forever for a dock called
   * "ZoneScan Lite" that Basecamp never creates. `init` writes exactly that,
   * so the documented init -> run workflow could not succeed for any app with
   * a display_name. Either spelling is accepted; each is used for its own job.
   */
  private async openApp(name: string, timeout: number): Promise<void> {
    const { moduleName, label } = this.resolveAppName(name);
    // The same builder every other command uses. `run` was the one verb that
    // passed no staged path, so its open-failure hint lost the sentence that
    // separates "Basecamp declined it" from "staging failed" — the one thing
    // that tells you which half to debug.
    const scope = await openApp(
      this.opts.session.inspector,
      moduleName,
      label,
      openOptionsFor(
        this.opts.app ?? null,
        this.opts.userDirRoot,
        moduleName,
        this.opts.openTimeoutMs,
      ),
    );
    this.scopeId = scope.scopeId;
    this.qmlRootId = scope.qmlRootId;
    const unlock = this.opts.walletUnlock;
    if (unlock && this.qmlRootId) {
      const why = await unlockWallet(this.opts.session.inspector, this.qmlRootId, unlock.provider, unlock.password);
      if (why) throw new Error(`the wallet did not unlock: ${why}`);
    }
    if (this.opts.onOpened && !this.openedHookRan) {
      this.openedHookRan = true;
      const outcome = await this.opts.onOpened();
      if (outcome.failed) {
        this.actionChecks.push({
          kind: "state",
          description: "the setup profile completed",
          verdict: "fail",
          detail: outcome.failed,
        });
      }
    }
  }

  /**
   * Retry the expectations until they hold or the step runs out of time.
   *
   * `settleMs` is the floor on how long a step must observe the app before a
   * clean result may be accepted. It exists because the inspector POSTS mouse
   * events: when the click call returns, nothing has handled it yet. A step
   * whose expectations are all monotone-positive can still return the instant
   * they hold — the evidence for them has arrived. But a negative expectation
   * ("does not call X", "no new errors") is trivially true before the app has
   * done anything, so accepting it immediately grades a click that has not
   * landed. Measured before this: pass after 27 ms, the forbidden call arrived
   * 300 ms later.
   */
  private async pollChecks(expect: Expect, cursor: LogCursor, timeout: number): Promise<Check[]> {
    const started = Date.now();
    const deadline = started + timeout;
    const settleUntil = started + Math.min(this.settleMs, timeout);
    let last: Check[] = [];
    for (;;) {
      const snap: UiSnapshot = await snapshot(this.ctx);
      const window = this.opts.session.logs.slice(cursor).map(parseLine);
      last = await runChecks(
        {
          inspector: this.opts.session.inspector,
          snapshot: snap,
          window,
          qmlRootId: this.qmlRootId,
          appName: this.opts.appName,
          logsUsable: this.opts.logsUsable,
          ignoreCalls: this.opts.spec.ignoreCalls ?? [],
          cursor,
        },
        expect,
      );
      const now = Date.now();
      // Inconclusive never becomes conclusive by waiting, so only retry on fail
      // — or when a negative expectation has not yet had time to be falsified.
      const clean = !last.some((c) => c.verdict === "fail");
      if (clean && (allMonotone(last) || now >= settleUntil)) return last;
      // And the dual: a window-based negative expectation that has ALREADY been
      // falsified cannot come true again, because the log window only grows. The
      // only early return used to require `clean`, so a step that had already
      // definitively failed spun until its deadline — the verdict was final in
      // the first second and the user waited out the whole 30 s default.
      if (settled(last)) return last;
      if (now >= deadline) return last;
      await sleep(250);
    }
  }

  private callsSince(cursor: LogCursor): string[] {
    const seen = new Set<string>();
    for (const c of callsIn(this.opts.session.logs.slice(cursor).map(parseLine))) seen.add(callName(c));
    return [...seen];
  }

  private async capture(name: string): Promise<void> {
    const dir = this.opts.artifactDir;
    // Returning quietly here made the step report `screenshot <name>` and PASS
    // while writing nothing — a green step that proved nothing at all.
    if (!dir) {
      throw new Error(`cannot capture "${name}": no artifact directory. Pass --artifacts <dir>.`);
    }
    const fs = await import("node:fs");
    const path = await import("node:path");
    const shot = await this.opts.session.inspector.screenshot(this.scopeId ?? undefined);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name.endsWith(".png") ? name : `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.image, "base64"));
  }
}

/** One phrase naming what a step is waiting on, for the status line. */
function describeExpect(e: Expect): string {
  const bits: string[] = [];
  if (e.text !== undefined) bits.push("visible text");
  if (e.state !== undefined) bits.push("app state");
  if (e.calls !== undefined) bits.push("backend calls");
  if (e.console !== undefined) bits.push("console output");
  return bits.length ? bits.join(" + ") : "the result";
}

function describeAction(step: Step): string {
  if (step.open !== undefined) return `open ${step.open}`;
  if (step.click !== undefined) return `click ${JSON.stringify(selText(step.click))}`;
  // The step's NAME is built before the field is resolved, so only the spec's
  // own `secret:` can mask it here. It reaches the status line, the terminal
  // report, the JSON and the JUnit.
  if (step.type !== undefined) return `type ${displayText(step.type.text, step.type.secret)}`;
  if (step.set !== undefined) return `set ${step.set.property}`;
  if (step.eval !== undefined) return `eval ${JSON.stringify(step.eval)}`;
  if (step.sleep !== undefined) return `sleep ${step.sleep}`;
  if (step.screenshot !== undefined) return `screenshot`;
  if (step.waitFor !== undefined) return "wait for";
  return "check";
}

function selText(sel: unknown): string {
  if (typeof sel === "string") return sel;
  const o = sel as { text?: string; objectName?: string; type?: string };
  return o.text ?? o.objectName ?? o.type ?? "(selector)";
}
