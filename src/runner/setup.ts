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
import { Runner } from "./runner.js";

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
  fidelity: { fidelity: "verbose" | "quiet" };
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
 * Parse a profile, or explain why it could not be parsed.
 *
 * Read before the app is opened, because a profile's `ignore_calls:` has to be
 * in force for the open step as well. It used to be parsed inside the runner
 * and its ignoreCalls thrown away, so a profile could declare its app's poll
 * and the crawl would ignore the declaration.
 */
export function loadSetupSpec(file: string, quietNarration?: boolean): Spec | null {
  try {
    return validateSpec(YAML.parse(fs.readFileSync(file, "utf8")));
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
 * Run a resolved profile against the already-open app.
 *
 * Reuses the ordinary spec runner, so a profile is written in exactly the same
 * language as a test — there is no second dialect to learn, and a profile that
 * stops working fails loudly with the same diagnostics.
 */
export async function runSetupProfile(
  b: SetupHost,
  resolved: { file: string; spec: Spec } | null,
  appName: string,
  whatFollows: string,
  quietNarration?: boolean,
): Promise<{ steps: number; failed: string | null }> {
  if (!resolved) return { steps: 0, failed: null };
  say(quietNarration, `  ${DIM}setup${RST} ${DIM}${path.relative(process.cwd(), resolved.file) || resolved.file}${RST}`);

  const runner = new Runner({
    session: b.session,
    spec: resolved.spec,
    appName,
    // `app` as well as `manifest`: openApp reads the declared `view` from
    // `app.manifest.view`, so passing only `manifest` left a profile's `open:`
    // on findQmlRoot's fallback — every `state:` in the profile then evaluated
    // against a Basecamp wrapper and FAILED with "evaluated to undefined" after
    // burning the step timeout.
    ...(b.app ? { manifest: b.app.manifest, app: b.app } : {}),
    ...(b.userDir ? { userDirRoot: b.userDir.root } : {}),
    logsUsable: b.fidelity.fidelity === "verbose",
    onNote: (line) => say(quietNarration, line),
    onStep: (r) => {
      const ok = r.verdict !== "fail";
      say(quietNarration, `        ${ok ? GRN + "·" + RST : RED + "x" + RST} ${DIM}${r.name}${RST}`);
      if (ok) return;
      for (const c of r.checks.filter((k) => k.verdict === "fail")) {
        say(quietNarration, `          ${RED}${c.description}${c.detail ? ` — ${c.detail}` : ""}${RST}`);
      }
      if (r.error) say(quietNarration, `          ${RED}${r.error.split("\n")[0]}${RST}`);
    },
  });
  const result = await runner.run();
  if (result.verdict !== "fail") return { steps: result.steps.length, failed: null };

  // It used to print red and exit 0. A profile that stopped working leaves the
  // app on the wrong screen, so everything reported after it is about a state
  // nobody asked to test.
  say(quietNarration, `  ${RED}FAIL${RST}  setup did not complete — continuing anyway, from wherever it stopped`);
  return {
    steps: result.steps.length,
    failed: `the setup profile did not complete, so the ${whatFollows} started from the wrong screen`,
  };
}
