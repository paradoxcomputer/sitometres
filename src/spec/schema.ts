// ---------------------------------------------------------------------------
// The test-spec format.
//
// A spec describes what a person does to the app and what should be true
// afterwards. Assertions come in three families, deliberately, because no
// single one is trustworthy on its own:
//
//   text   — what the user can see. Cheap, but a label can change for reasons
//            unrelated to the thing you meant to test.
//   state  — a QML expression evaluated inside the app. Precise, and the only
//            family that works on every build.
//   calls  — backend methods that were invoked, read out of the log. The
//            closest thing to "did my handler actually do its job", but only
//            observable on builds that ship Qt logging (see ../runner/fidelity).
//
// A step that asserts nothing still fails on a crash, an unresolvable selector
// or a new error in the log, so `- click: "Save"` on its own is already a
// useful test.
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
  /** Default per-step timeout, e.g. 10000 or "15s". */
  timeout?: number | string;
  /** Backend calls to ignore everywhere, e.g. a polling loop. */
  ignoreCalls?: string[];
  steps: Step[];
}

export interface Step {
  /** Shown in the report. Defaults to a description of the action. */
  name?: string;
  timeout?: number | string;
  /** Comment for documentation or breakpoints (e.g., "# breakpoint") */
  comment?: string;

  // --- actions (at most one per step) ---
  /** Open an app by clicking its sidebar entry and waiting for its dock. */
  open?: string;
  /** Click a control. */
  click?: SelectorInput;
  /** Type into a field. */
  type?: TypeAction;
  /** Evaluate a QML expression for its side effect. */
  eval?: string;
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

export interface Expect {
  /** Labels that must be visible. String or {text, match} selector form. */
  text?: SelectorInput | SelectorInput[];
  /** Labels that must NOT be visible. */
  notText?: SelectorInput | SelectorInput[];
  /** QML expressions that must evaluate truthy, in the app's own context. */
  state?: string | string[];
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

export class SpecError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "SpecError";
  }
}

/** Accepts 1500, "1500", "1.5s", "2m". */
export function parseDuration(v: number | string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === "number") return v;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(ms|s|m)?\s*$/.exec(v);
  if (!m) throw new Error(`cannot parse duration ${JSON.stringify(v)}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "m": return n * 60_000;
    case "s": return n * 1000;
    default: return n;
  }
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
const STEP_KEYS = new Set<string>([...ACTION_KEYS, "name", "timeout", "expect", "comment"]);

/** Validate a parsed YAML/JSON document into a Spec, with located errors. */
export function validateSpec(doc: unknown): Spec {
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
  for (const key of ["app", "basecamp", "headless", "timeout", "with", "ignoreCalls", "ignore_calls"]) {
    if (o[key] === null) delete o[key];
  }
  const spec: Spec = { steps };
  const wrong = (key: string, want: string, got: unknown): never => {
    throw new SpecError(`\`${key}\` must be ${want}, got ${Array.isArray(got) ? "a list" : typeof got}`, "$");
  };

  const KNOWN = new Set(["steps", "app", "basecamp", "headless", "timeout", "with", "ignoreCalls", "ignore_calls"]);
  for (const key of Object.keys(o)) {
    if (!KNOWN.has(key)) {
      throw new SpecError(`unknown key \`${key}\`. Known: ${[...KNOWN].filter((k) => k !== "ignoreCalls").join(", ")}`, "$");
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
  if (o.timeout !== undefined) {
    if (typeof o.timeout !== "number" && typeof o.timeout !== "string") {
      wrong("timeout", "a number of milliseconds or a duration like \"30s\"", o.timeout);
    }
    // Parsed here rather than at first use: it used to throw from the runner
    // AFTER staging and launching Basecamp, which is a slow way to learn about
    // a typo.
    try {
      parseDuration(o.timeout as string | number, NaN);
    } catch {
      throw new SpecError(
        `cannot parse timeout ${JSON.stringify(o.timeout)} — use milliseconds, or a duration like "30s" or "2m"`,
        "$",
      );
    }
    spec.timeout = o.timeout as string | number;
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
  return step;
}

const EXPECT_KEYS = new Set([
  "text", "notText", "state", "calls", "noCalls", "callsSucceed",
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
