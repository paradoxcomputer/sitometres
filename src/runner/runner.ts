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

import { type InspectorClient, sleep } from "../inspector/client.js";
import type { LogCursor } from "../logs/buffer.js";
import { CallWindowTracker, callName, callsIn, explainOpenFailure, pairFailures, parseLine } from "../logs/classify.js";
import type { Session } from "../app/lifecycle.js";
import { asArray, evalTarget, type Expect, parseDuration, type Spec, type Step } from "../spec/schema.js";
import { type ActionContext, displayText, doClick, doEval, doSet, doType, snapshot } from "./actions.js";
import { allMonotone, type Check, type InTarget, runChecks, settled, type Verdict, verdictOf } from "./assert.js";
import { type AppScope, locateScope, openApp, openOptionsFor, OpenError } from "./open.js";
import { type AppManifest, isViewModule, uiLabel } from "../app/manifest.js";
import { ChannelTracker } from "./fidelity.js";
import { status } from "../report/status.js";
import { resolveAll, type SelectorInput, SelectorError, toSelector } from "./selector.js";
import { UiSnapshot } from "./snapshot.js";
import { unlockWallet, type WalletProvider } from "../app/wallet.js";
import { createDebugREPL, type DebugContext, type DebugCallbacks } from "./debug.js";
import {
  commandTimeoutFor,
  DEFAULT_CALL_WINDOW_MS,
  DEFAULT_RUN_SETTLE_MS,
  defaultStepTimeout,
  describeBudget,
  hasDeadline,
} from "../timeouts.js";

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

/**
 * The half of a step's `comment:` that was written for a reader.
 *
 * `comment:` does two jobs. It is where an author says what a step is FOR, and
 * it is also how a spec marks a breakpoint — README, SKILL and the shipped
 * example all spell that `# breakpoint: <why>`. A directive is an instruction
 * to the runner, not something to narrate back: printing "# breakpoint" into a
 * report of a run that never paused (CI has no --debug) describes a pause that
 * did not happen. So the marker is dropped and only the `<why>` survives.
 *
 * Filtered here rather than in each writer so the terminal, the JSON and any
 * later reader cannot disagree about what counts as prose.
 *
 * The typeof guard is not decoration: validateStep allowlists `comment:`
 * without checking its type, and `comment: # breakpoint` — unquoted, which is
 * how a YAML comment is written everywhere else — parses as null. That reached
 * isBreakpointComment harmlessly because RegExp.test stringifies its argument;
 * anything reaching for .replace would take the run down at step one.
 */
export function commentProse(comment: string | undefined): string | undefined {
  if (typeof comment !== "string") return undefined;
  // The leading `#` is decoration carried over from writing YAML comments, not
  // part of the sentence.
  const text = comment.replace(/^\s*#+\s*/, "").trim();
  if (!isBreakpointComment(text)) return text === "" ? undefined : text;
  const colon = text.indexOf(":");
  const why = colon === -1 ? "" : text.slice(colon + 1).trim();
  return why === "" ? undefined : why;
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
  /**
   * The step's `comment:`, as INTENT — what the author said the step is for.
   *
   * Authored before the run existed, so it is not evidence and never belongs in
   * a Check: a `description` or a `detail` is what this run found, and prose
   * sitting there would read as a claim the tool never made. It travels in a
   * field of its own for exactly that reason. Absent, not empty, when the
   * comment was only a breakpoint directive — see commentProse.
   */
  comment?: string;
  /** Populated when the step blew up rather than merely failing a check. */
  error?: string;
  screenshot?: string;
  /**
   * Module name of the app the step ran in: the current app once the step's
   * action was done, so an `open:` records the app it opened. Absent until
   * some app has been opened.
   */
  app?: string;
}

/** A staged app, as much of it as opening one needs. */
export interface StagedAppRef {
  manifest: AppManifest;
  slot: string;
  artifact: string;
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
  /**
   * Every app the run staged, the app under test included. `open:` and `in:`
   * resolve against these, so a spec can move between a dApp and the wallet
   * it asks. Absent, the app under test is the only one there is.
   */
  apps?: StagedAppRef[];
  /** The discovered app, so the open hint can describe its staged directory. */
  app?: { manifest: { view?: string }; slot: string };
  /** Root of the staged user-dir, for the same reason. */
  userDirRoot?: string;
  /**
   * The $HOME the app under test was given, and what a relative `file:` path
   * resolves against.
   *
   * Null when this run chose none. Not the same as "there was no sandbox":
   * --real-home means the app really did see the developer's own $HOME and a
   * spec written against it keeps working, while attach mode means nothing was
   * chosen at all. See appHomeFor in ../session.ts.
   */
  appHome?: string | null;
  /**
   * How long to wait for an app to open, when neither the `open:` step's own
   * `timeout:` nor the spec's `open_timeout:` says. Separate from a step's
   * timeout: opening is not the step's work, and a short step budget used to
   * make the open unpassable.
   */
  openTimeoutMs?: number;
  /**
   * True when `openTimeoutMs` was chosen for opening (--open-timeout), so it is
   * honoured as given. Otherwise it is the startup --timeout reaching the open
   * for compatibility, and the open's floor applies. See openApp.
   */
  openTimeoutExplicit?: boolean;
  /** --step-timeout: a step's budget when neither the step nor the spec sets one. */
  stepTimeoutMs?: number;
  /**
   * --command-timeout: the longest one inspector command may block, when
   * neither the step nor the spec sets `command_timeout`.
   */
  commandTimeoutMs?: number;
  /**
   * --call-timeout: the Logos bridge's reply window, when the spec does not
   * declare `call_timeout`. Without either it is read from the log.
   */
  callTimeoutMs?: number;
  logsUsable: boolean;
  /** Where screenshots go. */
  artifactDir?: string;
  /**
   * Minimum time to observe the app after a gesture before accepting a clean
   * result that includes a negative expectation, when neither the step nor
   * the spec sets `settle` (--settle). See pollChecks().
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
   * Run after every `open:`, with the module just opened, once any wallet is
   * unlocked.
   *
   * This is where a setup profile belongs for `run`: after the spec's `open:`
   * has established the scope, before any of its assertions. A callback rather
   * than a Spec so the runner keeps no dependency on profile discovery, and so
   * the profile's own nested runner cannot recurse into another one. Which
   * profile belongs to which app, and running each once, is the caller's
   * bookkeeping: the runner only says what it opened.
   *
   * A profile that did not complete becomes a failing check on the open step,
   * because that is the step during which the gate was supposed to be walked,
   * and everything the spec asserts afterwards is about the wrong screen.
   *
   * `scope` is where that app was just found, so a profile run for it can
   * start inside that app's dock rather than across the whole window.
   */
  onOpened?: (moduleName: string, scope: OpenedScope) => Promise<{ failed: string | null }>;
  /**
   * Start with this app already open and current, as if a step had opened it.
   *
   * For a setup profile run from inside another run, once more than one app's
   * dock exists. A runner that has opened nothing resolves selectors against
   * the whole window and evaluates `state:` wherever the inspector falls back
   * to, which is the first QQuickWidget's root: with a dApp's dock and the
   * wallet's both in the tree, the wallet's profile could type into the dApp's
   * field and read the dApp's properties. Seeded, it acts in its own app.
   */
  initialScope?: { module: string; scope: OpenedScope };
}

/** An opened app's scope, plus the view that finds its root again. */
export type OpenedScope = AppScope & { view?: string };

/**
 * What one step may spend, resolved once when the step starts.
 *
 * Most specific wins: the step, then the spec's header, then the command
 * line, then a default derived from the bridge's reply window.
 */
export interface StepBudget {
  /** The step's whole budget, action plus expectations. Infinity means none. */
  timeoutMs: number;
  /** The deadline of every inspector command the step issues. */
  commandMs: number;
  /** The least time a clean negative expectation is watched. */
  settleMs: number;
  /** The bridge's reply window these were derived from. */
  callWindowMs: number;
  /** A `timeout:` written on the step itself, which an `open:` honours as its budget. */
  ownTimeoutMs?: number;
}

/**
 * How long a clean negative expectation is watched before it is accepted.
 *
 * The step's settle, whatever the action left of its budget. `settle: none`
 * means the step's whole `timeout:`: a clean result that could never be
 * accepted would make every step with a negative check unpassable.
 */
function settleOf(b: Pick<StepBudget, "settleMs" | "timeoutMs">): number {
  return hasDeadline(b.settleMs) ? b.settleMs : b.timeoutMs;
}

export class Runner {
  /** Module name of the app selectors and the default root belong to. */
  private current: string | null = null;
  /** Every app opened so far, by module name. Docks are hidden, not destroyed. */
  private readonly scopes = new Map<string, OpenedScope>();
  /**
   * True when the spec's `open:` steps and `in:` targets name more than one
   * app. Decided from the spec before step 1, because the terminal prints each
   * step as it finishes and cannot wait to learn whether a second app opens.
   */
  readonly multiApp: boolean;
  /** The module an `open:` in progress is opening, for its failure diagnosis. */
  private opening: string | null = null;
  /** The spec header's durations, parsed once. Undefined when the header is silent. */
  private readonly header: {
    timeout?: number;
    command?: number;
    call?: number;
    open?: number;
    settle?: number;
    openSettle?: number;
  };
  /** The bridge's reply window, as far as the log has shown it. */
  private readonly callWindows = new CallWindowTracker();
  /** Which of the host-debug and ui-host channels the log has shown so far. */
  private readonly channelTracker = new ChannelTracker();
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

  constructor(private readonly opts: RunnerOptions) {
    const spec = opts.spec;
    const read = (v: number | string | undefined): number | undefined =>
      v === undefined ? undefined : parseDuration(v, 0);
    this.header = {
      timeout: read(spec.timeout),
      command: read(spec.commandTimeout),
      call: read(spec.callTimeout),
      open: read(spec.openTimeout),
      settle: read(spec.settle),
      openSettle: read(spec.openSettle),
    };
    this.hasSpecBreakpoints = opts.spec.steps.some((s) => isBreakpointComment(s.comment));
    this.multiApp = this.namedApps().size > 1;
    if (opts.initialScope) {
      this.scopes.set(opts.initialScope.module, opts.initialScope.scope);
      this.current = opts.initialScope.module;
    }

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
   * Turn whatever the spec said into a staged app's module name and label.
   *
   * An app has two names, and a spec may use either: the module name docks,
   * the display label is what the sidebar shows. Every UI app the run staged
   * can be named, the spec's own and each one in `with:`; a staged core module
   * fails at once, since there is no dock to wait for.
   *
   * Falls back to using the name for both when no manifest is available (an
   * --attach run has no discovered app), which is correct when the two names
   * coincide.
   */
  private resolveStagedApp(name: string, verb: "opens" | "evaluates in" = "opens"): { moduleName: string; label: string } {
    const staged = this.stagedApps();
    if (staged.length === 0) return { moduleName: name, label: name };
    const hit = staged.find((a) => a.manifest.name === name || uiLabel(a.manifest) === name);
    if (hit && isCore(hit)) {
      throw new Error(
        `this spec ${verb} "${name}", which is ${hit.manifest.name}, a core module with no UI. ` +
          `It can name: ${this.nameableApps()}.`,
      );
    }
    if (hit) return { moduleName: hit.manifest.name, label: uiLabel(hit.manifest) };
    throw new Error(
      `this spec ${verb} "${name}", which is not a UI app this run staged. It can name: ${this.nameableApps()}. ` +
        `Use either spelling, or stage the app with \`with:\`.`,
    );
  }

  /** Every staged app, or the app under test alone when that is all there is. */
  private stagedApps(): StagedAppRef[] {
    if (this.opts.apps && this.opts.apps.length > 0) return this.opts.apps;
    const m = this.opts.manifest;
    if (!m) return [];
    return [{ manifest: m, slot: this.opts.app?.slot ?? (m.type === "core" ? "modules" : "plugins"), artifact: "" }];
  }

  /** Both spellings of every staged UI app, for a message about a name that is neither. */
  private nameableApps(): string {
    const ui = this.stagedApps().filter((a) => !isCore(a));
    if (ui.length === 0) return "(no UI app was staged)";
    return ui
      .map((a) => (uiLabel(a.manifest) === a.manifest.name ? a.manifest.name : `${a.manifest.name} ("${uiLabel(a.manifest)}")`))
      .join(", ");
  }

  /** The distinct modules the spec's `open:` steps and `in:` targets name. */
  private namedApps(): Set<string> {
    const names = new Set<string>();
    const add = (n: string): void => {
      const hit = this.stagedApps().find((a) => a.manifest.name === n || uiLabel(a.manifest) === n);
      names.add(hit ? hit.manifest.name : n);
    };
    for (const step of this.opts.spec.steps) {
      if (typeof step.open === "string") add(step.open);
      if (step.eval !== undefined) {
        const t = evalTarget(step.eval);
        if (t.in !== undefined) add(t.in);
      }
      for (const e of [step.expect, step.waitFor]) {
        for (const entry of asArray(e?.state)) {
          const t = evalTarget(entry);
          if (t.in !== undefined) add(t.in);
        }
      }
    }
    return names;
  }

  /** The scope selectors and the default root belong to. */
  private get currentScope(): OpenedScope | null {
    return this.current === null ? null : (this.scopes.get(this.current) ?? null);
  }

  /** The current app's QML root, which a string `state:` and `eval:` evaluate in. */
  private get qmlRootId(): string | null {
    return this.currentScope?.qmlRootId ?? null;
  }

  /**
   * The QML root of another opened app, for `in:`.
   *
   * The root's id was cached when that app was opened, and while the spec was
   * busy elsewhere the app's QML may have reloaded. The real inspector does not
   * fail an evaluation against an id it no longer knows: it quietly evaluates
   * in the FIRST QQuickWidget's root instead, which is some other app. So the
   * id is checked with a depth-0 tree read, which does fail on an unknown id,
   * and a stale scope is found again once through the dock, the way opening it
   * found it. Checked per evaluation because it is one small call; finding the
   * scope again is a tree walk, and happens only when the check fails.
   */
  private async rootFor(name: string): Promise<InTarget> {
    let target: { moduleName: string };
    try {
      target = this.resolveStagedApp(name, "evaluates in");
    } catch (err) {
      return { kind: "not-staged", detail: (err as Error).message };
    }
    const module = target.moduleName;
    const scope = this.scopes.get(module);
    if (!scope) {
      return {
        kind: "not-open",
        module,
        detail: `${module} has not been opened in this run, so it has no root to evaluate in yet. ` +
          `Add an \`open: ${name}\` step before this one.`,
      };
    }
    const inspector = this.opts.session.inspector;
    if (scope.qmlRootId) {
      try {
        await inspector.getTree({ objectId: scope.qmlRootId, depth: 0 });
        return { kind: "ok", module, rootId: scope.qmlRootId };
      } catch {
        /* stale: find it again below */
      }
    }
    let again: AppScope | null = null;
    try {
      again = await locateScope(inspector, module, scope.view);
    } catch {
      /* reported below */
    }
    if (again?.qmlRootId) {
      this.scopes.set(module, { ...again, ...(scope.view ? { view: scope.view } : {}) });
      return { kind: "ok", module, rootId: again.qmlRootId };
    }
    return {
      kind: "no-root",
      module,
      detail: scope.qmlRootId
        ? `${module}'s QML root is gone, and looking for it again in its dock found none`
        : `${module} is open, but its dock holds no QML type matching the \`view\` its manifest declares`,
    };
  }

  /**
   * The Logos bridge's reply window: declared in the spec, else on the command
   * line, else the largest `timeout: N` the log has shown on a synchronous
   * dispatch so far, else the stock 20 s.
   *
   * Asked again at every step, so a Basecamp built with a longer window is
   * followed as soon as its first call is logged.
   */
  callWindow(): number {
    const declared = this.header.call ?? this.opts.callTimeoutMs;
    if (declared !== undefined) return declared;
    const logs = this.opts.session.logs;
    const learned = typeof logs?.slice === "function" ? this.callWindows.observe(logs) : null;
    return learned ?? DEFAULT_CALL_WINDOW_MS;
  }

  /**
   * Everything a step may spend, resolved once as it starts.
   *
   * The step's `timeout:` defaults to 30 s, or the bridge window plus 10 s when
   * that is longer: at 15 s a call that timed out could not be seen to have
   * timed out, because the step's evidence window had closed before the
   * failure was logged. Each inspector command in the step may take as long as
   * the step itself, and never less than the bridge window plus 10 s, because
   * a synchronous backend call holds the thread that answers the inspector
   * until the bridge gives up. `command_timeout` decouples the two, for a long
   * wait that should still notice a hung app quickly.
   */
  budgetFor(step: Step): StepBudget {
    const read = (v: number | string | undefined): number | undefined =>
      v === undefined ? undefined : parseDuration(v, 0);
    const callWindowMs = this.callWindow();
    const own = read(step.timeout);
    const timeoutMs = own ?? this.header.timeout ?? this.opts.stepTimeoutMs ?? defaultStepTimeout(callWindowMs);
    const commandMs =
      read(step.commandTimeout) ??
      this.header.command ??
      this.opts.commandTimeoutMs ??
      Math.max(timeoutMs, commandTimeoutFor(callWindowMs));
    const settleMs = read(step.settle) ?? this.header.settle ?? this.opts.settleMs ?? DEFAULT_RUN_SETTLE_MS;
    return { timeoutMs, commandMs, settleMs, callWindowMs, ...(own !== undefined ? { ownTimeoutMs: own } : {}) };
  }

  /**
   * Run `fn` with every inspector command bounded by `ms`.
   *
   * Feature-detected: a hand-built inspector (the plain objects the tests
   * drive) has no deadlines to scope, and runs `fn` as it is.
   */
  private scoped<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const inspector = this.opts.session.inspector as Partial<Pick<InspectorClient, "withCommandTimeout">>;
    return typeof inspector.withCommandTimeout === "function" ? inspector.withCommandTimeout(ms, fn) : fn();
  }

  private get ctx(): ActionContext {
    return { inspector: this.opts.session.inspector, scopeId: this.currentScope?.scopeId ?? null };
  }

  /**
   * Where an action's selector resolves: the current app, or Basecamp's own
   * shell for a selector written `in: shell`.
   *
   * Basecamp 0.3.0 draws its dialogs (the intent chooser, dependency and
   * uninstall confirmations) in an overlay outside every app's dock, so a
   * selector scoped to the app can never reach them. `in: shell` resolves
   * against that overlay (objectName "overlayDialogs"), or against the whole
   * window on a build that has none.
   */
  private async ctxFor(sel: SelectorInput): Promise<ActionContext> {
    if (typeof sel !== "object" || sel === null || sel.in !== "shell") return this.ctx;
    const inspector = this.opts.session.inspector;
    let overlay: string | null = null;
    try {
      const hit = (await inspector.findByProperty("objectName", "overlayDialogs"))?.matches?.[0];
      overlay = hit ? String(hit.id) : null;
    } catch {
      /* no overlay to scope to: the whole window it is */
    }
    return { inspector, scopeId: overlay };
  }

  /**
   * Run an action, and when its selector finds nothing in the app, say so if
   * the control is in one of Basecamp's own dialogs instead. Asked only after
   * the failure, so a passing action costs nothing, and only of a build that
   * has the overlay (0.3.0).
   */
  private async shellHinted<T>(sel: SelectorInput, act: () => Promise<T>): Promise<T> {
    try {
      return await act();
    } catch (err) {
      if (!(err instanceof SelectorError) || (typeof sel === "object" && sel !== null && sel.in === "shell")) throw err;
      const inspector = this.opts.session.inspector;
      try {
        const overlay = (await inspector.findByProperty("objectName", "overlayDialogs"))?.matches?.[0];
        if (overlay) {
          const snap = await UiSnapshot.capture(inspector, String(overlay.id));
          if (resolveAll(snap, toSelector(sel)).length > 0) {
            err.message +=
              "\n  That control is in one of Basecamp's own dialogs, outside the app: add `in: shell` to the selector.";
          }
        }
      } catch {
        /* the hint is a courtesy; the selector's own error stands */
      }
      throw err;
    }
  }

  /**
   * The channels the log has shown so far, when this run can read logs at all.
   * Asked at each poll, so a channel that shows itself mid-step counts at once.
   */
  private channelsNow(): { hostDebug: boolean; viewHost: boolean } | undefined {
    const logs = this.opts.session.logs;
    if (!this.opts.logsUsable || typeof logs?.slice !== "function") return undefined;
    return this.channelTracker.observe(logs);
  }

  /** The current app, when it is a view module (its calls come from a ui-host). */
  private get viewModuleApp(): string | null {
    if (this.current === null) return null;
    const app = this.stagedApps().find((a) => a.manifest.name === this.current);
    return app && isViewModule(app.manifest) ? this.current : null;
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
    const rest = this.opts.spec.steps.slice(from).map((step, k) => {
      // The author's own words survive an abort too. These steps are
      // INCONCLUSIVE rather than absent precisely so a reader can place them,
      // and "what was this step for" is most of placing one.
      const prose = commentProse(step.comment);
      return {
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
        ...(prose !== undefined ? { comment: prose } : {}),
      };
    });
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
    const cursor = this.opts.session.logs.mark();
    this.stepCursor = cursor;
    this.actionChecks = [];
    let action = describeAction(step);
    status.set("Running", `step ${index + 1}/${this.opts.spec.steps.length}: ${step.name ?? action}`);

    const prose = commentProse(step.comment);
    const base: StepResult = {
      index,
      name: step.name ?? action,
      action,
      verdict: "pass",
      durationMs: 0,
      checks: [],
      callsObserved: [],
      ...(prose !== undefined ? { comment: prose } : {}),
    };

    let budget: StepBudget | null = null;
    let actionDone = started;
    try {
      // Resolved inside the try: validateSpec refuses a bad duration before
      // anything launches, but a spec built by hand reaches here unchecked, and
      // a budget that cannot be read fails this step instead of the whole run.
      budget = this.budgetFor(step);
      const b = budget;
      const performed = await this.scoped(b.commandMs, () => this.perform(step, b));
      actionDone = Date.now();
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
        // Diagnosed against the app being opened, which is not always the
        // spec's own: a `with:` app that did not compile has to be named.
        const opening = this.opening ?? this.opts.appName;
        const why = opening
          ? explainOpenFailure(this.opts.session.logs.slice(cursor).map(parseLine), opening)
          : null;
        if (why) extra = `\n  ${why.split("\n").join("\n  ")}`;
        else if (err.hint) extra = `\n  ${err.hint}`;
      }
      base.error = (err instanceof SelectorError ? err.message : (err as Error).message) + extra;
      base.verdict = "fail";
      base.durationMs = Date.now() - started;
      base.callsObserved = this.callsSince(cursor);
      if (this.current !== null) base.app = this.current;
      return base;
    } finally {
      this.opening = null;
    }
    if (this.current !== null) base.app = this.current;

    if (this.pendingChecks) {
      base.checks = this.pendingChecks;
      this.pendingChecks = null;
    }
    if (this.actionChecks.length > 0) base.checks = [...base.checks, ...this.actionChecks];
    if (base.checks.length > 0) base.verdict = verdictOf(base.checks);
    const expect = step.expect;
    if (expect) {
      status.set("Running", `step ${index + 1}: checking ${describeExpect(expect)}`);
      // Whatever is left of the step's budget, and never less than one look:
      // a budget the action used up still gets its expectations checked once,
      // rather than a hidden extra second. An `open:` that ran on the open
      // budget is not charged to the step at all, since opening an app is not
      // the step's work; one with a `timeout:` of its own spent that budget.
      // The settle is not part of that budget: a negative expectation is
      // watched for all of it however long the action took (see pollChecks).
      const b = budget!;
      const from = step.open !== undefined && b.ownTimeoutMs === undefined ? actionDone : started;
      const left = Math.max(0, b.timeoutMs - (Date.now() - from));
      try {
        base.checks = [...base.checks, ...(await this.scoped(b.commandMs, () => this.pollChecks(expect, cursor, left, settleOf(b))))];
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
  private async perform(step: Step, budget: StepBudget): Promise<string | null> {
    if (step.open !== undefined) {
      await this.openApp(step.open, budget, step);
      return `opened ${step.open}`;
    }
    if (step.click !== undefined) {
      return (await this.shellHinted(step.click, async () => doClick(await this.ctxFor(step.click!), step.click!))).detail;
    }
    if (step.type !== undefined) {
      const out = await this.shellHinted(step.type.into, async () => doType(await this.ctxFor(step.type!.into), step.type!));
      // An action that learned something must not have it discarded. `type:`
      // reads the field back, so it can know the text did not land — and that
      // used to survive only as prose while the step reported PASS with no
      // checks at all.
      if (out.check) this.actionChecks.push({ kind: "state", ...out.check });
      return out.detail;
    }
    if (step.set !== undefined) {
      return (await this.shellHinted(step.set.target, async () => doSet(await this.ctxFor(step.set!.target), step.set!))).detail;
    }
    if (step.eval !== undefined) return this.evaluateStep(step.eval);
    if (step.sleep !== undefined) {
      await sleep(parseDuration(step.sleep, 0));
      return null;
    }
    if (step.screenshot !== undefined) {
      await this.capture(step.screenshot);
      return `screenshot ${step.screenshot}`;
    }
    if (step.waitFor !== undefined) {
      const checks = await this.pollChecks(step.waitFor, this.opts.session.logs.mark(), budget.timeoutMs, settleOf(budget));
      const bad = checks.filter((c) => c.verdict === "fail");
      if (bad.length > 0) {
        throw new Error(
          `waitFor never came true within ${describeBudget(budget.timeoutMs)}:\n  ` +
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
  private async openApp(name: string, budget: StepBudget, step: Step): Promise<void> {
    const { moduleName, label } = this.resolveStagedApp(name);
    this.opening = moduleName;
    const staged = this.stagedApps().find((a) => a.manifest.name === moduleName);
    // The same builder every other command uses. `run` was the one verb that
    // passed no staged path, so its open-failure hint lost the sentence that
    // separates "Basecamp declined it" from "staging failed" — the one thing
    // that tells you which half to debug.
    const scope = await openApp(
      this.opts.session.inspector,
      moduleName,
      label,
      {
        ...openOptionsFor(
          staged ?? this.opts.app ?? null,
          this.opts.userDirRoot,
          moduleName,
          this.openBudget(budget),
        ),
        ...(this.header.openSettle !== undefined ? { settleMs: this.header.openSettle } : {}),
      },
    );
    const view = staged?.manifest.view ?? this.opts.app?.manifest.view;
    const opened: OpenedScope = { ...scope, ...(view ? { view } : {}) };
    this.scopes.set(moduleName, opened);
    this.current = moduleName;
    // Only through the spec's own app. That is the app the wallet provider was
    // detected for, and a password must never be handed to another app's
    // bridge just because the spec opened it.
    const unlock = this.opts.walletUnlock;
    if (unlock && scope.qmlRootId && moduleName === this.opts.appName) {
      // The unlock is a synchronous backend call, and the app has just logged
      // its first dispatches, which carry the bridge window this build really
      // uses. The step's budget was resolved before any of them, so it is
      // raised to that window here, unless a command deadline was chosen.
      const chosen = step.commandTimeout ?? this.header.command ?? this.opts.commandTimeoutMs;
      const unlockMs = chosen !== undefined ? budget.commandMs : Math.max(budget.commandMs, commandTimeoutFor(this.callWindow()));
      const why = await this.scoped(unlockMs, () =>
        unlockWallet(this.opts.session.inspector, scope.qmlRootId!, unlock.provider, unlock.password),
      );
      if (why) throw new Error(`the wallet did not unlock: ${why}`);
    }
    if (this.opts.onOpened) {
      const outcome = await this.opts.onOpened(moduleName, opened);
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
   * How long an `open:` may take, and whether someone chose that.
   *
   * The step's own `timeout:`, then the spec's `open_timeout:`, then the
   * command line. A spec-level `timeout:` is deliberately not among them: it
   * is every step's budget, and a short one used to make opening unpassable.
   */
  private openBudget(budget: StepBudget): { timeoutMs?: number; explicit: boolean } {
    if (budget.ownTimeoutMs !== undefined) return { timeoutMs: budget.ownTimeoutMs, explicit: true };
    if (this.header.open !== undefined) return { timeoutMs: this.header.open, explicit: true };
    if (this.opts.openTimeoutMs !== undefined) {
      return { timeoutMs: this.opts.openTimeoutMs, explicit: this.opts.openTimeoutExplicit === true };
    }
    return { explicit: false };
  }

  /**
   * Perform an `eval:` step, in the current app or in the one `in:` names.
   *
   * An app that has not been opened, or a name that was not staged, is an
   * error here rather than INCONCLUSIVE: an `eval:` is done for its side
   * effect, and one that could not run leaves the app somewhere the rest of
   * the spec does not expect.
   */
  private async evaluateStep(input: NonNullable<Step["eval"]>): Promise<string> {
    const { expr, in: target } = evalTarget(input);
    if (target === undefined) return (await doEval(this.ctx, expr, this.qmlRootId)).detail;
    const where = await this.rootFor(target);
    if (where.kind !== "ok") {
      throw new Error(`cannot evaluate ${JSON.stringify(expr)} in ${target}: ${where.detail}`);
    }
    return `${(await doEval(this.ctx, expr, where.rootId)).detail} in ${where.module}`;
  }

  /** The app under test, then every app opened so far: whose errors count. */
  private attributedApps(): string[] {
    const out: string[] = [];
    if (this.opts.appName) out.push(this.opts.appName);
    for (const m of this.scopes.keys()) if (!out.includes(m)) out.push(m);
    return out;
  }

  /**
   * Retry the expectations until they hold or the step runs out of time.
   *
   * They are always checked at least once, however little time is left. A
   * poll can overshoot `timeout` by one round of commands, each bounded by the
   * step's command deadline.
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
   *
   * The settle is kept apart from `timeout`, which is only what the action
   * left of the step's budget. Capping one by the other let a slow action
   * leave no settle at all, and a negative expectation passed on its first
   * look while the forbidden call was still on its way. So a clean result is
   * watched for the whole settle, past the deadline if need be; a failing one
   * stops at the deadline, as it always has.
   */
  private async pollChecks(expect: Expect, cursor: LogCursor, timeout: number, settleMs: number): Promise<Check[]> {
    const started = Date.now();
    const deadline = started + timeout;
    const settleUntil = started + settleMs;
    let last: Check[] = [];
    for (;;) {
      const snap: UiSnapshot = await snapshot(this.ctx);
      const window = this.opts.session.logs.slice(cursor).map(parseLine);
      const channels = this.channelsNow();
      last = await runChecks(
        {
          inspector: this.opts.session.inspector,
          snapshot: snap,
          window,
          qmlRootId: this.qmlRootId,
          appNames: this.attributedApps(),
          rootFor: (name) => this.rootFor(name),
          logsUsable: this.opts.logsUsable,
          ...(channels ? { channels } : {}),
          viewModuleApp: this.viewModuleApp,
          ignoreCalls: this.opts.spec.ignoreCalls ?? [],
          appHome: this.opts.appHome ?? null,
          userDirRoot: this.opts.userDirRoot ?? null,
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
      // Past the deadline only a clean result that has not yet been watched
      // for its settle is looked at again.
      if (now >= deadline && !clean) return last;
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
    const shot = await this.opts.session.inspector.screenshot(this.currentScope?.scopeId ?? undefined);
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
  if (e.file !== undefined) bits.push("a file on disk");
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
  if (step.eval !== undefined) {
    const t = evalTarget(step.eval);
    return `eval ${JSON.stringify(t.expr)}${t.in !== undefined ? ` in ${t.in}` : ""}`;
  }
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

/** A staged app with no UI to open. */
function isCore(a: StagedAppRef): boolean {
  return a.slot === "modules" || a.manifest.type === "core";
}
