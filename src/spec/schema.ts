// ---------------------------------------------------------------------------
// The test-spec format.
//
// A spec describes what a person does to the app and what should be true
// afterwards. Assertions come in four families, deliberately, because no
// single one is trustworthy on its own:
//
//   text   — what the user can see. Cheap, but a label can change for reasons
//            unrelated to the thing you meant to test.
//   state  — a QML expression evaluated inside the app. Precise, and the only
//            family that works on every build.
//   calls  — backend methods that were invoked, read out of the log. The
//            closest thing to "did my handler actually do its job", but only
//            observable on builds that ship Qt logging (see ../runner/fidelity).
//   file   — something the app left on disk, under the $HOME this run gave it.
//            Needs neither the log nor the QML tree, and is the only family
//            that outlives the app. It proves the file is THERE, not that this
//            step wrote it.
//
// A step that asserts nothing still fails on a crash, an unresolvable selector
// or a new error in the log, so `- click: "Save"` on its own is already a
// useful test.
//
// A spec with no steps at all is a different thing, and is refused: no gesture
// is made, no selector is resolved and no log window is opened, so none of the
// four families has anything to read. See validateSpec.
// ---------------------------------------------------------------------------

import type { SelectorInput } from "../runner/selector.js";

export interface Spec {
  /** Module name of the app under test. Defaults to the sole discovered app. */
  app?: string;
  /** Extra apps to stage alongside it (dependencies built elsewhere). */
  with?: string[];
  /** Path to a Basecamp binary. Defaults to whatever `locateBasecamp` finds. */
  basecamp?: string;
  /** Run without a window. Default true. */
  headless?: boolean;
  /**
   * Default per-step budget, action plus expectations, e.g. 10000, "15s" or
   * "none". Does not govern `open:`; see `openTimeout`.
   */
  timeout?: number | string;
  /**
   * The longest any one inspector command may block, for every step that does
   * not set its own. Default: the step's own timeout, but never less than the
   * bridge's reply window plus 10 s.
   */
  commandTimeout?: number | string;
  /**
   * The Logos bridge's reply window. Only derives defaults and messages; the
   * log usually says it (`timeout: N` on each synchronous dispatch).
   */
  callTimeout?: number | string;
  /** The budget for every `open:` that sets no `timeout:` of its own. */
  openTimeout?: number | string;
  /** How long to wait for Basecamp to start. `--timeout` wins over this. */
  startupTimeout?: number | string;
  /** How long a step watches before accepting a clean negative expectation. */
  settle?: number | string;
  /** The pause for an app's first paint once its dock exists. */
  openSettle?: number | string;
  /** Backend calls to ignore everywhere, e.g. a polling loop. */
  ignoreCalls?: string[];
  steps: Step[];
}

export interface Step {
  /** Shown in the report. Defaults to a description of the action. */
  name?: string;
  /**
   * This step's budget, action plus expectations. On an `open:` step it is the
   * budget for the open itself, honoured exactly as written.
   */
  timeout?: number | string;
  /** The longest any one inspector command in this step may block. */
  commandTimeout?: number | string;
  /** How long this step watches before accepting a clean negative expectation. */
  settle?: number | string;
  /**
   * Why this step exists, in the author's words. Printed under the step and
   * carried into `--json`, never as an assertion. `# breakpoint: <why>` also
   * marks the step as a `--debug` breakpoint; the marker itself is not printed.
   */
  comment?: string;

  // --- actions (at most one per step) ---
  /** Open an app by clicking its sidebar entry and waiting for its dock. */
  open?: string;
  /** Click a control. */
  click?: SelectorInput;
  /** Type into a field. */
  type?: TypeAction;
  /**
   * Evaluate a QML expression for its side effect. A string runs in the
   * current app's root; `{ expr, in: <app> }` runs in another opened app's
   * root without moving the step's scope.
   */
  eval?: EvalInput;
  /** Set a property on a control. */
  set?: { target: SelectorInput; property: string; value: unknown };
  /** Wait for an expectation to become true before continuing. */
  waitFor?: Expect;
  /** Unconditional pause. Prefer waitFor — a sleep is a guess. */
  sleep?: number | string;
  /** Capture a PNG into the run's artifact directory. */
  screenshot?: string;

  /** What must be true after the action. */
  expect?: Expect;
}

export interface TypeAction {
  into: SelectorInput;
  text: string;
  /**
   * Key to press afterwards. `sendKeys` can only produce printable characters,
   * so Enter/Tab are delivered by invoking the field's own signal instead —
   * see ../runner/actions.ts.
   */
  then?: "enter" | "tab" | "none";
  /** Replace the field's contents instead of appending. Default true. */
  clear?: boolean;
  /**
   * Never print this text, or the field's contents, anywhere.
   *
   * Without it, a value typed by a spec was copied verbatim into stdout, the
   * live status line, the JSON report and the JUnit file — and the tool's own
   * shipped profile types a password. A field whose `echoMode` hides its input
   * is masked automatically as a backstop, but that is only known after the
   * selector resolves; `secret: true` is what masks the step's name too.
   */
  secret?: boolean;
}

/**
 * A file the app should have left behind.
 *
 * The same three shapes `text:` takes — a bare path, this object, or a list of
 * either — because `contains` refines the same question the way `match` refines
 * a selector, and `toFileExpect` normalises a string into this exactly as
 * `toSelector` does. The list-only rule `calls:`/`events:` carry does not apply:
 * those are bare names with nothing to refine, and their rule exists for a
 * scalar that used to be spread character by character.
 */
export interface FileExpect {
  /**
   * Relative to the `$HOME` this run gave the app — the only spelling that
   * means the same thing in a sandboxed run and under --real-home. An absolute
   * path is taken literally but must still land in a directory this run owns;
   * see resolveFilePath in ../runner/assert.ts.
   */
  path: string;
  /** Substring the file must contain. Read as UTF-8. */
  contains?: string;
}

export type FileInput = string | FileExpect;

export interface Expect {
  /** Labels that must be visible. String or {text, match} selector form. */
  text?: SelectorInput | SelectorInput[];
  /** Labels that must NOT be visible. */
  notText?: SelectorInput | SelectorInput[];
  /**
   * QML expressions that must evaluate truthy, in the current app's root. An
   * entry written `{ expr, in: <app> }` is evaluated in that app's root
   * instead, which must have been opened already.
   */
  state?: EvalInput | EvalInput[];
  /**
   * Files that must exist, under the $HOME this run gave the app.
   *
   * The only oracle here that needs neither the log nor the QML tree, so it is
   * the one that still works on a Release build where `calls:` cannot. A path
   * outside the run's own directories is INCONCLUSIVE, not a failure — see
   * resolveFilePath.
   */
  file?: FileInput | FileInput[];
  /** Backend calls that must have been made, as "module.method" or "method". */
  calls?: string[];
  /** Backend calls that must NOT have been made. */
  noCalls?: string[];
  /** Fail if any call made during this step failed or timed out. Default true. */
  callsSucceed?: boolean;
  /** Fail on new QML errors attributed to the app under test. Default true. */
  noErrors?: boolean;
  /**
   * Fail on new QML *warnings* from the app: missing image assets, binding
   * loops, anchors inside a Layout, `Cannot override FINAL property`. Off by
   * default because a healthy app still emits some, but worth turning on -
   * a missing asset is a real defect that `no_errors` deliberately ignores.
   */
  noWarnings?: boolean;
  /** Substrings that must appear in the app's own console.log output. */
  console?: string | string[];
  /** Typed module events that must have been emitted. */
  events?: string[];
}

/**
 * An expression for `state:` or `eval:`, and where to evaluate it.
 *
 * A bare string means the current app's root, exactly as it always has. The
 * object form names another app the run staged, so a dApp spec can watch the
 * wallet's state without leaving the dApp: a step often checks `text:` in the
 * app on screen together with `state:` about the other one, which is why `in:`
 * belongs to the expression and not to the step.
 */
export type EvalInput = string | { expr: string; in?: string };

/** Either spelling of an EvalInput, as `{ expr, in? }`. */
export function evalTarget(input: EvalInput): { expr: string; in?: string } {
  if (typeof input === "string") return { expr: input };
  return input.in === undefined ? { expr: input.expr } : { expr: input.expr, in: input.in };
}

export class SpecError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "SpecError";
  }
}

/**
 * Read a duration: 1500, "1500", "500ms", "1.5s", "2m", "1h", or "none" /
 * "unlimited" for no deadline at all (Infinity).
 *
 * There is deliberately no maximum. A negative duration, or one that is not a
 * number, is refused rather than guessed at.
 */
export function parseDuration(v: number | string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new Error(`cannot parse duration ${String(v)}`);
    if (v < 0) throw new Error(`a duration cannot be negative, got ${v}`);
    return v;
  }
  if (/^\s*(none|unlimited)\s*$/i.test(v)) return Infinity;
  const m = /^\s*(-?)\s*([0-9]*\.?[0-9]+)\s*(ms|s|m|h)?\s*$/.exec(v);
  if (!m) throw new Error(`cannot parse duration ${JSON.stringify(v)}`);
  if (m[1]) throw new Error(`a duration cannot be negative, got ${JSON.stringify(v)}`);
  const n = Number(m[2]);
  switch (m[3]) {
    case "h": return n * 3_600_000;
    case "m": return n * 60_000;
    case "s": return n * 1000;
    default: return n;
  }
}

/** What a duration may be written as, for the messages that refuse one. */
export const DURATION_FORMS = 'milliseconds, or a duration like "500ms", "30s", "2m" or "1h", or "none" for no deadline';

/**
 * Check a duration where it is written, so a typo is found before anything is
 * staged or launched. `unlimited: false` refuses "none" for a wait that has to
 * end, like `sleep:`.
 */
function checkDuration(key: string, v: unknown, path: string, unlimited = true): void {
  if (typeof v !== "number" && typeof v !== "string") {
    throw new SpecError(
      `\`${key}\` must be ${DURATION_FORMS}, got ${Array.isArray(v) ? "a list" : v === null ? "null" : typeof v}`,
      path,
    );
  }
  let ms: number;
  try {
    ms = parseDuration(v, NaN);
  } catch (err) {
    const why = (err as Error).message;
    if (/negative/.test(why)) throw new SpecError(`\`${key}\` ${why.replace(/^a duration /, "")}`, path);
    throw new SpecError(`cannot parse ${key} ${written(v)}. Use ${DURATION_FORMS}`, path);
  }
  if (!unlimited && !Number.isFinite(ms)) {
    throw new SpecError(`\`${key}\` has to end, so it cannot be ${written(v)}`, path);
  }
}

/**
 * A value as the author wrote it, for a message that refuses it.
 *
 * JSON.stringify spells YAML's `.inf` and `.nan` (and a number too large for
 * a double, which YAML reads as infinity) as "null", a value nobody wrote and
 * one this schema reads as "not set".
 */
function written(v: number | string): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (Number.isNaN(v)) return "NaN (not a number)";
  if (!Number.isFinite(v)) return `${v < 0 ? "-" : ""}infinity`;
  return String(v);
}

export function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

const ACTION_KEYS = ["open", "click", "type", "eval", "set", "waitFor", "sleep", "screenshot"] as const;

/**
 * Every key a step may carry. Unknown keys are rejected rather than ignored:
 * a mistyped `clik:` used to validate cleanly and then do nothing, which reads
 * as a passing test of a control that was never touched.
 */
const STEP_KEYS = new Set<string>([
  ...ACTION_KEYS, "name", "timeout", "commandTimeout", "settle", "expect", "comment",
]);

/** Header keys holding a duration, as YAML spells them, with the Spec field each fills. */
const HEADER_DURATIONS: Array<[yaml: string, field: keyof Spec]> = [
  ["timeout", "timeout"],
  ["command_timeout", "commandTimeout"],
  ["call_timeout", "callTimeout"],
  ["open_timeout", "openTimeout"],
  ["startup_timeout", "startupTimeout"],
  ["settle", "settle"],
  ["open_settle", "openSettle"],
];

/**
 * Validate a parsed YAML/JSON document into a Spec, with located errors.
 *
 * `allowNoSteps` is for setup profiles, and nothing else. A profile's
 * `ignore_calls:` is load-bearing on its own — the crawl reads it off the
 * parsed profile before the app is even opened, so the open step is graded with
 * it in force — so an app with no gate to walk through but a background poll
 * has a profile worth writing and nothing to put in `steps:`. Refusing that
 * would be caught by loadSetupSpec, turned into a null, and the crawl would run
 * with NO ignore list: the same swallowed-refusal failure the null-header
 * handling below exists to prevent.
 */
export function validateSpec(doc: unknown, allowNoSteps = false): Spec {
  if (typeof doc !== "object" || doc === null) throw new SpecError("spec must be a mapping", "$");
  const o = doc as Record<string, unknown>;

  if (!Array.isArray(o.steps)) throw new SpecError("missing required list `steps`", "$");
  const steps: Step[] = o.steps.map((raw, i) => validateStep(raw, `$.steps[${i}]`));

  // Every key below used to be an `if (typeof …)` that silently dropped what it
  // did not recognise, while a mistyped key inside a STEP was rejected. The
  // worst form was in a setup profile: a scalar `ignore_calls:` vanished, so
  // the crawl ran with no ignore list and a background poll made every inert
  // control report `ran`. A header that means something other than what it says
  // is the same defect as a check that proves nothing.
  // YAML parses a key whose entries are all commented out as null. The step
  // validator already treats that as "nothing set" (see `expect`), and the
  // header must agree: rejecting it meant a setup profile with a commented-out
  // ignore list was refused, then swallowed by loadSetupSpec — so the crawl ran
  // with NO setup and NO ignore list, which is the failure per-app-call-noise
  // existed to prevent.
  // Header durations are accepted in either spelling, like `ignore_calls`.
  const DURATION_ALIASES = HEADER_DURATIONS.filter(([yaml, field]) => yaml !== field).map(([, field]) => field);
  for (const key of [
    "app", "basecamp", "headless", "with", "ignoreCalls", "ignore_calls",
    ...HEADER_DURATIONS.map(([yaml]) => yaml), ...DURATION_ALIASES,
  ]) {
    if (o[key] === null) delete o[key];
  }
  const spec: Spec = { steps };
  const wrong = (key: string, want: string, got: unknown): never => {
    throw new SpecError(`\`${key}\` must be ${want}, got ${Array.isArray(got) ? "a list" : typeof got}`, "$");
  };

  const KNOWN = new Set([
    "steps", "app", "basecamp", "headless", "with", "ignoreCalls", "ignore_calls",
    ...HEADER_DURATIONS.map(([yaml]) => yaml), ...DURATION_ALIASES,
  ]);
  const aliases = new Set(["ignoreCalls", ...DURATION_ALIASES]);
  for (const key of Object.keys(o)) {
    if (!KNOWN.has(key)) {
      throw new SpecError(`unknown key \`${key}\`. Known: ${[...KNOWN].filter((k) => !aliases.has(k)).join(", ")}`, "$");
    }
  }

  if (o.app !== undefined) {
    if (typeof o.app !== "string") wrong("app", "a string", o.app);
    spec.app = o.app as string;
  }
  if (o.basecamp !== undefined) {
    if (typeof o.basecamp !== "string") wrong("basecamp", "a string", o.basecamp);
    spec.basecamp = o.basecamp as string;
  }
  if (o.headless !== undefined) {
    if (typeof o.headless !== "boolean") wrong("headless", "true or false", o.headless);
    spec.headless = o.headless as boolean;
  }
  // Parsed here rather than at first use: a bad `timeout` used to throw from
  // the runner AFTER staging and launching Basecamp, which is a slow way to
  // learn about a typo.
  for (const [yaml, field] of HEADER_DURATIONS) {
    const v = o[yaml] ?? o[field];
    if (v === undefined) continue;
    if (yaml === "timeout" && typeof v !== "number" && typeof v !== "string") {
      wrong("timeout", "a number of milliseconds or a duration like \"30s\"", v);
    }
    // open_settle is a pause, and a pause has to end.
    checkDuration(yaml, v, "$", field !== "openSettle");
    (spec as unknown as Record<string, unknown>)[field] = v;
  }
  if (o.with !== undefined) {
    if (!Array.isArray(o.with) || o.with.some((x) => typeof x !== "string")) {
      wrong("with", "a list of app names", o.with);
    }
    spec.with = o.with as string[];
  }
  const ignore = o.ignoreCalls ?? o.ignore_calls;
  if (ignore !== undefined) {
    if (!Array.isArray(ignore) || ignore.some((x) => typeof x !== "string")) {
      wrong("ignore_calls", "a list of call names", ignore);
    }
    spec.ignoreCalls = ignore as string[];
  }

  // `steps: []` validated cleanly, and a run of it graded zero steps —
  // verdictOf([]) is a pass by design, because `calls_succeed: false` produces
  // exactly that at the check level — so a truncated file, or one whose steps
  // were all commented out, launched a Basecamp, drove nothing, resolved no
  // selector, read no log window, and exited 0 green. That is the failure this
  // tool exists to catch, arriving through its own front door.
  //
  // Refused here rather than graded in the runner, for the reason `timeout` is
  // parsed here: the runner learns it only after staging and launching. And
  // INCONCLUSIVE would be the wrong verdict anyway — it means an expectation
  // could not be CHECKED on this build, and this spec asked for none.
  //
  // Last, after every header check: a document that is both mis-typed in the
  // header and empty should be told about the header, which is the error its
  // author can act on.
  if (!allowNoSteps && steps.length === 0) {
    throw new SpecError(
      "`steps` is empty — a spec that drives nothing can only report a pass it did not earn. " +
        "Add a step, or delete the file",
      "$",
    );
  }
  return spec;
}

function validateStep(raw: unknown, path: string): Step {
  if (typeof raw !== "object" || raw === null) throw new SpecError("step must be a mapping", path);
  const o = camelise(raw as Record<string, unknown>);

  for (const key of Object.keys(o)) {
    if (!STEP_KEYS.has(key)) {
      throw new SpecError(
        `unknown key \`${key}\`. Known: ${[...STEP_KEYS].join(", ")}`,
        path,
      );
    }
  }

  const actions = ACTION_KEYS.filter((k) => o[k] !== undefined);
  if (actions.length === 0 && o.expect === undefined) {
    throw new SpecError(
      `step has no action and no expect. Use one of: ${ACTION_KEYS.join(", ")}`,
      path,
    );
  }
  if (actions.length > 1) {
    throw new SpecError(
      `step has ${actions.length} actions (${actions.join(", ")}); split it into separate steps`,
      path,
    );
  }

  // A duration written wrong used to be found only when the runner reached the
  // step, after Basecamp had launched, and it took the whole run down with it.
  for (const [key, yaml, unlimited] of [
    ["timeout", "timeout", true],
    ["commandTimeout", "command_timeout", true],
    ["settle", "settle", true],
    // A sleep with no end is a hang, not a test.
    ["sleep", "sleep", false],
  ] as const) {
    // A commented-out budget means "not set", as it does in the header. Not
    // for `sleep:`, which is the step's action: a null one is a mistake.
    if (o[key] === null && key !== "sleep") {
      delete o[key];
      continue;
    }
    if (o[key] !== undefined) checkDuration(yaml, o[key], `${path}.${yaml}`, unlimited);
  }

  const step = o as unknown as Step;
  // `expect:` whose entries are all commented out parses as null, and a null
  // expect used to skip the checks entirely — including the default "the app
  // did not throw". That is exactly what `init` generates, and its own comment
  // promises that check. An empty block means the defaults, not nothing.
  if (step.expect === null) step.expect = {};
  if (step.expect) validateExpect(step.expect, `${path}.expect`);
  if (step.waitFor) validateExpect(step.waitFor, `${path}.waitFor`);
  if (step.type && (typeof step.type.text !== "string" || step.type.into === undefined)) {
    throw new SpecError("`type` needs both `into` (a selector) and `text`", path);
  }
  if (step.eval !== undefined) validateEvalInput(step.eval, "eval", `${path}.eval`);
  // `in:` on an action's selector says where to look for the control, and the
  // one place other than the app itself is Basecamp's shell. Anything else
  // would be silently ignored and the control looked for in the app.
  for (const [sel, where] of [
    [step.click, "click"],
    [step.type?.into, "type.into"],
    [step.set?.target, "set.target"],
  ] as const) {
    if (typeof sel !== "object" || sel === null) continue;
    const at = (sel as { in?: unknown }).in;
    if (at !== undefined && at !== "shell") {
      throw new SpecError(
        `\`in: ${JSON.stringify(at)}\` on a selector can only be \`shell\`, for Basecamp's own dialogs. ` +
          "To act in another app, open it first with an `open:` step.",
        `${path}.${where}`,
      );
    }
  }
  return step;
}

const EXPECT_KEYS = new Set([
  "text", "notText", "state", "file", "calls", "noCalls", "callsSucceed",
  "noErrors", "noWarnings", "console", "events",
]);

function validateExpect(e: Expect, path: string): void {
  for (const key of Object.keys(e)) {
    if (!EXPECT_KEYS.has(key)) {
      throw new SpecError(`unknown expectation \`${key}\`. Known: ${[...EXPECT_KEYS].join(", ")}`, path);
    }
  }
  // A bare string here used to be spread character by character — `no_calls:
  // "mod.doThing"` produced twelve checks named "does not call m", "does not
  // call o", … every one of which passed while the call had in fact been made.
  // These three are the only expectations that take a list and nothing else.
  const yamlName: Record<string, string> = { calls: "calls", noCalls: "no_calls", events: "events" };
  for (const key of ["calls", "noCalls", "events"] as const) {
    const v = (e as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      throw new SpecError(
        `\`${yamlName[key]}\` must be a list, even for one entry — write ` +
          `\`${yamlName[key]}: [${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}]\``,
        path,
      );
    }
    for (const c of v) {
      if (typeof c !== "string" || c.length === 0) {
        throw new SpecError(`\`${yamlName[key]}\` entries must be strings like "medusa_core.getZones"`, path);
      }
    }
  }

  // `in:` only scopes an action; a text expectation always reads the app the
  // step is in, so one written with `in:` would silently read somewhere else.
  for (const key of ["text", "notText"] as const) {
    for (const sel of asArray((e as Record<string, unknown>)[key] as unknown)) {
      if (typeof sel === "object" && sel !== null && (sel as { in?: unknown }).in !== undefined) {
        throw new SpecError(
          `\`in:\` is not supported inside \`${key === "text" ? "text" : "not_text"}\`: it only scopes an action ` +
            "(click, type, set) to Basecamp's shell",
          path,
        );
      }
    }
  }

  const states = e.state;
  if (states !== undefined) {
    const list = Array.isArray(states) ? states : [states];
    list.forEach((entry, i) =>
      validateEvalInput(entry, "state", Array.isArray(states) ? `${path}.state[${i}]` : `${path}.state`),
    );
  }

  // The object form is where a typo hides. `file: [{ pth: "x" }]` would reach
  // the runner as an expectation with no path at all, and an expectation that
  // constrains nothing is the silently-passing check `caseFix` exists to
  // prevent — the same defect a snake_case key inside a selector list caused.
  for (const entry of asArray(e.file)) {
    if (typeof entry === "string") {
      if (entry.length === 0) throw new SpecError("`file` needs a path, not an empty string", path);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SpecError(
        "`file` must be a path, `{ path: \"…\", contains: \"…\" }`, or a list of either — got " +
          (entry === null ? "null" : Array.isArray(entry) ? "a nested list" : typeof entry),
        path,
      );
    }
    const o = entry as unknown as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k !== "path" && k !== "contains") {
        throw new SpecError(`unknown key \`${k}\` in \`file\`. Known: path, contains`, path);
      }
    }
    if (typeof o.path !== "string" || o.path.length === 0) {
      throw new SpecError("`file` needs a `path`, e.g. `file: { path: \".local/share/app/x.json\" }`", path);
    }
    if (o.contains !== undefined && typeof o.contains !== "string") {
      throw new SpecError("`contains` must be a string", path);
    }
    // Every file contains "", an empty one included, so this check could not
    // fail — the silently-passing expectation the rest of this validator exists
    // to refuse. The author either meant a value, or meant the path alone.
    if (o.contains === "") {
      throw new SpecError(
        "`contains` is empty, and every file contains an empty string — this check cannot fail. " +
          "Give it a value, or drop it to assert only that the file exists",
        path,
      );
    }
  }
}

/**
 * A `state:` entry or an `eval:` value: a string, or `{ expr, in? }`.
 *
 * Refused here, before anything is launched, with the same care as `file:`.
 * `{ in: my_wallet }` with no `expr` would reach the runner as an expression
 * that evaluates `undefined`, and a key spelled `where:` would silently
 * evaluate in the current app instead of the one the author named.
 */
function validateEvalInput(v: unknown, key: "state" | "eval", path: string): void {
  // A bare string is accepted exactly as before this form existed.
  if (typeof v === "string") return;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new SpecError(
      `\`${key}\` must be an expression or \`{ expr: "…", in: <app> }\`, got ` +
        (v === null ? "null" : Array.isArray(v) ? "a nested list" : typeof v),
      path,
    );
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== "expr" && k !== "in") {
      throw new SpecError(`unknown key \`${k}\` in \`${key}\`. Known: expr, in`, path);
    }
  }
  if (typeof o.expr !== "string" || o.expr.length === 0) {
    throw new SpecError(
      `\`${key}\` needs an \`expr\`, e.g. \`${key}: { expr: "root.phase === 'idle'", in: my_app }\``,
      path,
    );
  }
  if (o.in !== undefined && (typeof o.in !== "string" || o.in.length === 0)) {
    throw new SpecError(`\`in\` must name a staged app, as a string`, path);
  }
}

/** YAML in this ecosystem is snake_case; the API is camelCase. Accept both. */
function camelise(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const key = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = caseFix(v);
  }
  return out;
}

/**
 * Recurse through arrays too.
 *
 * Skipping them left `text: [{ object_name: "x" }]` with its raw key, so the
 * selector arrived with every field undefined — and a selector that constrains
 * nothing matches everything, which made the assertion pass whatever the app
 * rendered. A silently passing check is the worst defect a test runner can have,
 * and the list form is exactly what the docs teach for multiple labels.
 */
function caseFix(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(caseFix);
  if (v && typeof v === "object") return camelise(v as Record<string, unknown>);
  return v;
}
