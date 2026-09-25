// ---------------------------------------------------------------------------
// Setup profiles — getting an app past its front door.
//
// SKILL.md calls writing one "the high-value task", and it is: medusa_ui opens
// on "Create your wallet" and a crawl of that screen finds four controls, while
// a crawl behind it finds the unlock flow, the account row, the faucet and the
// auto-lock. A profile is an ordinary spec, run before the real work.
//
// This lives here rather than inside the crawl because it was only ever
// reachable from the crawl, and that cost users twice over: a written spec had
// to inline and maintain its own copy of the gate walkthrough — examples/
// medusa_wallet.yaml duplicates profiles/medusa_ui.yaml, with nothing keeping
// them in step — and `init`, the documented first step of the init -> run
// workflow, could not scaffold past a gate at all, so it wrote a starter spec
// built from the login dialog's controls rather than the app's.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import type { DiscoveredApp } from "../app/discover.js";
import type { Session } from "../app/lifecycle.js";
import { type Spec, validateSpec } from "../spec/schema.js";
import { type OpenedScope, Runner } from "./runner.js";
import { openBudgetFrom, type TimeoutFlags } from "../timeouts.js";

// Same rule as every other reporter: honour a pipe and NO_COLOR. Painting
// unconditionally put escape codes in output the user had asked to be plain.
const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const DIM = colour ? "\x1b[2m" : "";
const RST = colour ? "\x1b[0m" : "";
const GRN = colour ? "\x1b[32m" : "";
const RED = colour ? "\x1b[31m" : "";

/** What a command needs to accept for setup to work. Every verb that opens an app has these. */
export interface SetupOptions {
  /** An explicit profile, overriding discovery. */
  setup?: string;
  /** Skip an auto-discovered profile. */
  noSetup?: boolean;
  /** Where the command was invoked, for discovery. */
  cwd?: string;
  /**
   * Send this narration to stderr instead of stdout.
   *
   * For a command whose stdout is a machine-readable payload — `inspect --json`
   * — where a line of prose in the middle of the document is the difference
   * between output a program can read and output it cannot.
   */
  quietNarration?: boolean;
}

/** Narrate to whichever stream is not carrying the payload. */
function say(quiet: boolean | undefined, line: string): void {
  if (quiet) process.stderr.write(line + "\n");
  else console.log(line);
}

/** Enough of a booted session to run a profile against. */
export interface SetupHost {
  session: Session;
  app?: DiscoveredApp | null;
  userDir?: { root: string } | null;
  /** The $HOME the app was given, so a profile can assert `file:` too. */
  appHome?: string | null;
  fidelity: { fidelity: "verbose" | "quiet" };
  /**
   * The command line's time budgets. A profile inherits them the way a spec
   * does: its own header and steps still win.
   */
  timeouts?: TimeoutFlags;
  /**
   * `run --settle`, which a profile inherits the same way. Kept out of
   * TimeoutFlags on purpose: a crawl's --settle is how long it watches each
   * click, not a settle for the steps of the profile it runs first.
   */
  settleMs?: number;
}

/** Profiles shipped with sitometres, beside the compiled output. */
export function profilesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "profiles");
}

/**
 * Directories to search, nearest first.
 *
 * The app's own directory and its ancestors up to the repo root, then wherever
 * the command was invoked. Discovery used to join every candidate onto ONE
 * directory — the app-search root — with no upward walk and no lookup relative
 * to the app that was actually discovered. So the workflow SKILL.md and README
 * both document (write `.sitometres/<app>.setup.yaml` in the app's repo, then
 * run `sitometres <app>` from anywhere) found nothing at all unless you happened
 * to be standing in exactly the right directory, and the crawl silently
 * explored the login screen.
 */
export function setupSearchRoots(cwd: string, appDir: string | null): string[] {
  const roots: string[] = [];
  let dir = appDir ? path.resolve(appDir) : null;
  for (let i = 0; dir && i < 8; i++) {
    roots.push(dir);
    // A repo root is where "the app's own repo" ends. Climbing past it would
    // start reading a sibling checkout's profile.
    if (fs.existsSync(path.join(dir, ".git"))) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  roots.push(path.resolve(cwd));
  return [...new Set(roots)];
}

/**
 * Where a setup spec lives, if anybody wrote one.
 *
 * The app's own repo first, then where the command was run, then the profiles
 * shipped with sitometres — so an app nobody has written a setup for still
 * benefits if one ships with the tool.
 */
export function findSetupSpec(cwd: string, appName: string, appDir: string | null = null): string | null {
  const candidates: string[] = [];
  for (const root of setupSearchRoots(cwd, appDir)) {
    candidates.push(
      path.join(root, ".sitometres", `${appName}.setup.yaml`),
      path.join(root, ".sitometres", "setup.yaml"),
      path.join(root, `${appName}.setup.yaml`),
      path.join(root, "sitometres.setup.yaml"),
    );
  }
  candidates.push(path.join(profilesDir(), `${appName}.yaml`));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * A profile written for one app BY NAME, for an app the spec did not name.
 *
 * A cross-app spec stages its dApp's wallet with `with:`, and opening the
 * wallet has to walk the wallet's gate. Only the named spellings are tried:
 * `.sitometres/setup.yaml` and `sitometres.setup.yaml` belong to whatever the
 * directory's own app is, and landing one on the wallet would type the spec
 * app's gate into it. `--setup` is the spec app's too, for the same reason.
 */
export function findNamedSetupSpec(cwd: string, appName: string, appDir: string | null = null): string | null {
  const candidates: string[] = [];
  for (const root of setupSearchRoots(cwd, appDir)) {
    candidates.push(
      path.join(root, ".sitometres", `${appName}.setup.yaml`),
      path.join(root, `${appName}.setup.yaml`),
    );
  }
  candidates.push(path.join(profilesDir(), `${appName}.yaml`));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Parse a profile, or explain why it could not be parsed.
 *
 * Read before the app is opened, because a profile's `ignore_calls:` has to be
 * in force for the open step as well. It used to be parsed inside the runner
 * and its ignoreCalls thrown away, so a profile could declare its app's poll
 * and the crawl would ignore the declaration.
 */
export function loadSetupSpec(file: string, quietNarration?: boolean): Spec | null {
  try {
    // Steps optional here, and only here. An app with no gate to walk through
    // can still owe the crawl an `ignore_calls:` — smoke reads it off this spec
    // before the open step is graded — and a profile refused for having no
    // steps comes back null from this very function, taking the ignore list
    // with it. A profile is not graded, so no green verdict rides on it.
    return validateSpec(YAML.parse(fs.readFileSync(file, "utf8")), true);
  } catch (err) {
    // Through say(), like every other line here. Writing straight to stdout
    // meant a profile that did not parse put red prose into the middle of
    // `inspect --json`'s payload — the exact invariant the quiet mode exists to
    // keep, defeated by the one path that reports a problem.
    say(quietNarration, `        ${RED}${(err as Error).message}${RST}`);
    return null;
  }
}

/**
 * Find and parse this app's profile, saying either way.
 *
 * A miss used to be entirely silent: the `setup <file>` line printed only when
 * one was found, so "your profile ran" and "your profile was never found, and
 * everything below is a crawl of your login screen" looked identical.
 */
export function resolveSetupSpec(
  opts: SetupOptions,
  appName: string,
  appDir: string | null,
): { file: string; spec: Spec } | null {
  if (opts.noSetup) return null;
  const file = opts.setup ?? findSetupSpec(opts.cwd ?? process.cwd(), appName, appDir);
  if (!file) {
    say(opts.quietNarration, `  ${DIM}setup${RST} ${DIM}none found for ${appName}${RST}`);
    say(
      opts.quietNarration,
      `        ${DIM}if it opens on a login or onboarding gate, write one at ` +
        `.sitometres/${appName}.setup.yaml${RST}`,
    );
    return null;
  }
  if (!fs.existsSync(file)) {
    say(opts.quietNarration, `  ${DIM}setup${RST} ${RED}${file} does not exist${RST}`);
    return null;
  }
  const spec = loadSetupSpec(file, opts.quietNarration);
  return spec ? { file, spec } : null;
}

/**
 * `resolveSetupSpec` for an app in `with:`: the named spellings only, and the
 * same narration, so "no profile for the wallet" is said rather than implied.
 */
export function resolveNamedSetupSpec(
  opts: SetupOptions,
  appName: string,
  appDir: string | null,
): { file: string; spec: Spec } | null {
  if (opts.noSetup) return null;
  const file = findNamedSetupSpec(opts.cwd ?? process.cwd(), appName, appDir);
  if (!file) {
    say(opts.quietNarration, `  ${DIM}setup${RST} ${DIM}none found for ${appName}${RST}`);
    return null;
  }
  const spec = loadSetupSpec(file, opts.quietNarration);
  return spec ? { file, spec } : null;
}

/**
 * Run a resolved profile against the already-open app.
 *
 * Reuses the ordinary spec runner, so a profile is written in exactly the same
 * language as a test — there is no second dialect to learn, and a profile that
 * stops working fails loudly with the same diagnostics.
 *
 * `hostApp` is the app the profile belongs to, when that is not `b.app`: a
 * `with:` app's profile runs against that app's manifest, so its own `open:`
 * resolves to the wallet and not to the dApp that staged it.
 *
 * `initialScope` is that app's open dock, handed on to the profile's runner so
 * it starts inside it. The caller passes it only once a second app's dock
 * exists: with one dock there is nothing else to land in, and leaving the
 * profile unscoped there keeps a single-app run exactly as it was.
 */
export async function runSetupProfile(
  b: SetupHost,
  resolved: { file: string; spec: Spec } | null,
  appName: string,
  whatFollows: string,
  quietNarration?: boolean,
  hostApp?: DiscoveredApp,
  initialScope?: { module: string; scope: OpenedScope },
): Promise<{ steps: number; failed: string | null }> {
  if (!resolved) return { steps: 0, failed: null };
  const host = hostApp ?? b.app ?? null;
  say(quietNarration, `  ${DIM}setup${RST} ${DIM}${path.relative(process.cwd(), resolved.file) || resolved.file}${RST}`);

  // A runner only has a QML root once an `open:` step (or an initial scope) gave it one. A
  // profile that never opens its app therefore evaluated every `state:` against nothing, got
  // INCONCLUSIVE, and an inconclusive step counted as done: a profile "passed" a create/unlock
  // gate it never actually drove, and the spec behind it started on the create screen. Open the
  // app first unless the profile already does, so its state checks really evaluate.
  // Only a profile that reads app state needs the root; a text-only profile runs exactly as before.
  const opensItself = resolved.spec.steps.some((s) => s.open !== undefined);
  const needsRoot = resolved.spec.steps.some(
    (s) =>
      s.eval !== undefined ||
      s.set !== undefined ||
      (s.expect as { state?: unknown } | undefined)?.state !== undefined ||
      (s.waitFor as { state?: unknown } | undefined)?.state !== undefined,
  );
  const spec: Spec =
    opensItself || initialScope || !needsRoot
      ? resolved.spec
      : { ...resolved.spec, steps: [{ name: `open ${appName}`, open: appName }, ...resolved.spec.steps] };

  const flags = b.timeouts ?? {};
  const open = openBudgetFrom(flags);
  const runner = new Runner({
    session: b.session,
    spec,
    appName,
    ...(open.timeoutMs !== undefined ? { openTimeoutMs: open.timeoutMs, openTimeoutExplicit: open.explicit } : {}),
    ...(flags.stepTimeoutMs !== undefined ? { stepTimeoutMs: flags.stepTimeoutMs } : {}),
    ...(flags.commandTimeoutMs !== undefined ? { commandTimeoutMs: flags.commandTimeoutMs } : {}),
    ...(flags.callTimeoutMs !== undefined ? { callTimeoutMs: flags.callTimeoutMs } : {}),
    ...(b.settleMs !== undefined ? { settleMs: b.settleMs } : {}),
    // `app` as well as `manifest`: openApp reads the declared `view` from
    // `app.manifest.view`, so passing only `manifest` left a profile's `open:`
    // on findQmlRoot's fallback — every `state:` in the profile then evaluated
    // against a Basecamp wrapper and FAILED with "evaluated to undefined" after
    // burning the step timeout.
    ...(host ? { manifest: host.manifest, app: host } : {}),
    ...(initialScope ? { initialScope } : {}),
    ...(b.userDir ? { userDirRoot: b.userDir.root } : {}),
    appHome: b.appHome ?? null,
    logsUsable: b.fidelity.fidelity === "verbose",
    onNote: (line) => say(quietNarration, line),
    onStep: (r) => {
      // A gate is passed only by a step that PROVED it: an inconclusive step (nothing could be
      // read) is not a pass for a profile, whatever it would be for an exploratory run.
      const ok = r.verdict === "pass";
      say(quietNarration, `        ${ok ? GRN + "·" + RST : RED + "x" + RST} ${DIM}${r.name}${RST}`);
      if (ok) return;
      for (const c of r.checks.filter((k) => k.verdict !== "pass")) {
        say(quietNarration, `          ${RED}${c.description}${c.detail ? ` — ${c.detail}` : ""}${RST}`);
      }
      if (r.error) say(quietNarration, `          ${RED}${r.error.split("\n")[0]}${RST}`);
    },
  });
  const result = await runner.run();
  if (result.verdict === "pass") return { steps: result.steps.length, failed: null };

  // It used to print red and exit 0. A profile that stopped working leaves the
  // app on the wrong screen, so everything reported after it is about a state
  // nobody asked to test.
  say(quietNarration, `  ${RED}FAIL${RST}  setup did not complete — continuing anyway, from wherever it stopped`);
  return {
    steps: result.steps.length,
    failed: `the setup profile did not complete, so the ${whatFollows} started from the wrong screen`,
  };
}
