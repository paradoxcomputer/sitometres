#!/usr/bin/env node
// ---------------------------------------------------------------------------
// sitometres — UI tests for Logos Basecamp apps.
// ---------------------------------------------------------------------------

import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { doctor } from "./commands/doctor.js";
import { printBanner } from "./report/terminal.js";
import { status } from "./report/status.js";
import { init } from "./commands/init.js";
import { inspect } from "./commands/inspect.js";
import { run } from "./commands/run.js";
import { smoke } from "./commands/smoke.js";
import { homeAndWallet } from "./app/wallet.js";
import { BootError, type CommandDeps, REAL_DEPS } from "./session.js";
import { SpecError } from "./spec/schema.js";
import { SelectorError } from "./runner/selector.js";
import { InspectorTransportError } from "./inspector/protocol.js";
import { VERSION } from "./version.js";

const USAGE = `
sitometres ${VERSION} — UI tests for Logos Basecamp apps

  Drives real mouse clicks through Basecamp's QML inspector and checks what
  each one actually caused: the backend calls it made, whether they succeeded,
  and what the user can now see.

USAGE
  sitometres [app]              test an app — this is the whole interface
  sitometres <command> [app]    when you want something more specific

  The app is found by name wherever it lives: the current directory, or your
  Basecamp install. With no name, the app in the current directory is used.
  It runs against a throwaway Basecamp AND a throwaway HOME, so your real
  wallets, keys and settings are never touched.

    sitometres                  # test the app in this directory
    sitometres my_app           # test that app, from anywhere

COMMANDS
  (none)             Same as smoke.
  smoke              Click through your app with no spec. Start here.
  run <spec.yaml>    Run a written spec.
  inspect            List the controls in your app, as pasteable selectors.
  init               Write a starter spec from your app's real controls.
  doctor             Check this machine can run tests, and what logs will show.

COMMON OPTIONS — every command
  --app <name>       Which app, when the directory holds more than one.
                     Usually unnecessary — pass the name positionally instead.
  --app-dir <path>   Where to look for the app. Default: current directory.
  --basecamp <path>  Basecamp binary to use. Must have the QML inspector.
  --quiet, -q        Do not print the banner.
  -h, --help         This text.  -V, --version  Print the version.

APP OPTIONS — smoke, run, inspect, init
  Each of these commands stages an app and launches Basecamp; doctor does not,
  and refuses them rather than accepting and ignoring them.

  --real-home        Let the app see your real $HOME, and therefore the wallet
                     and settings your Basecamp is already configured with.
                     Off by default: a run normally gets a throwaway HOME so it
                     is reproducible and cannot touch real data.
  --wallet-password  Unlock the wallet after opening the app. Unlocks whichever
                     wallet the run is using - it does NOT switch you to your
                     real one; that is --real-home. Only for wallets that have
                     a password at all (Medusa does; the standard Logos wallet
                     does not). Prefer SITOMETRES_WALLET_PASSWORD - a flag is
                     visible to 'ps'. Neither is passed on to the app.
  --with <a,b>       Also stage these apps (dependencies built elsewhere).
  --user-dir <path>  Run against this user-dir instead of a throwaway one.
                     $LOGOS_USER_DIR is also honoured when looking for an app
                     and its dependencies in your Basecamp install.
                     The app under test and anything staged with it REPLACE
                     what is installed under those names — the header says
                     which. Everything else is left alone.
  --reset-user-dir   With --user-dir: clear its plugins, modules, module data
                     and logs first. Destructive, so it is opt-in.
  --keep-staged      With --user-dir: leave the staged build there afterwards.
                     By default the run puts the directory back as it found it —
                     whatever it replaced is moved aside and swapped back, and
                     anything it added is removed. Use this when installing the
                     build IS the point.
  --variant <name>   Which platform variant to unpack from a .lgx, e.g.
                     linux-amd64-dev. Default: this host's.
  --port <n>         Inspector port. Default: a free one.
  --headed           Show the window instead of running offscreen.
  --attach [port]    Drive a Basecamp that is already running.
  --logs-dir <path>  With --attach: where that instance writes its logs.
  --env <K=V>        Set an env var for the app. Repeatable. Rarely needed —
                     the throwaway HOME already isolates app state.
  --timeout <ms>     Startup timeout. Default: 120000.
  --setup <file>     Spec to run before the real work, to get the app past a
                     login or onboarding gate. Auto-discovered from
                     .sitometres/<app>.setup.yaml in the app's own repo, or a
                     profile shipped with sitometres. --no-setup skips it.

SMOKE OPTIONS
  --limit <n>        Controls to click. Default: 12.
  --settle <ms>      Time to observe after each click. Default: 2500.
  --skip <a,b>       Labels to leave alone.
  --ignore-calls <a,b>
                     Backend calls to disregard when grading a click, e.g. your
                     app's polling loop. Accepts "module.method", "method" or
                     "module.*". Your setup profile's ignore_calls: is used too.
  --junit <file>     Write JUnit XML: one case per control clicked.
  --json <file>      Write the machine-readable report.
  --report <file>    Where to write the JSON report.
                     Default: .sitometres/<app>.json
  --no-report        Do not write a report file.
  --strict           Fail the build when the run proved nothing: no control did
                     anything observable, or log evidence could not be read.
                     Off by default — unreadable evidence is a property of the
                     build under test, not of your app. Turn it on for CI.

RUN OPTIONS
  --json <file>      Write a JSON report.
  --junit <file>     Write JUnit XML (INCONCLUSIVE becomes <skipped>).
  --artifacts <dir>  Where screenshot steps write their PNGs.
  --strict           Fail the build when the run proved nothing (INCONCLUSIVE).
  --debug            Interactive debug mode: pause at step boundaries and on
                     failures, with inspection commands. Needs a terminal.
  --breakpoint <n>   Pause before step N. Requires --debug. Marking steps with
                     comment: "# breakpoint" in the spec does the same thing.

INSPECT / INIT OPTIONS
  --hidden           Include controls that are not currently visible.
  --json             Machine-readable output (inspect). Only the JSON document
                     goes to stdout; progress goes to stderr.
  --out <file>       Spec to write (init). Default: sitometres.yaml.
  --force            Overwrite an existing spec (init).

DOCTOR OPTIONS
  --deep             Launch Basecamp to measure what the logs will show.
  --set-basecamp <p> Remember this Basecamp binary for every future run.
                     Stored in ~/.config/sitometres/config.json.

LICENCE
  MIT OR Apache-2.0. Copyright Paradox Computer.
  https://github.com/paradoxcomputer/sitometres

EXAMPLES
  sitometres                          # test the app in this directory
  sitometres my_app                   # test any installed app, from anywhere
  sitometres inspect my_app           # what can I click?
  sitometres init my_app              # write me a spec to start from
  sitometres run spec.yaml --junit results.xml
`;

interface Args {
  /** The command this line runs, resolved the same way arity was. */
  verb: string;
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
  /** Every occurrence of a repeatable flag, in order. */
  repeated: Map<string, string[]>;
}

/**
 * What each flag does with the token after it.
 *
 * `value` consumes it, `boolean` never does, `optional` consumes it only when
 * it does not look like another flag. Without this every flag took the next
 * non-dash token, so `sitometres --real-home medusa_ui` read "medusa_ui" as the
 * VALUE of --real-home and then tested whatever app was in the current
 * directory — against the developer's real $HOME. Verified before the fix.
 */
type Arity = "boolean" | "value" | "optional";

/** Flags every command understands. */
/**
 * Flags every command understands, because every command can act on them.
 *
 * Deliberately small. Anything a particular command does not READ belongs in
 * its own table, not here: `doctor` used to accept and silently ignore fifteen
 * of these — `doctor --headed --port 9000 --real-home` ran clean and did none
 * of it — which is the same defect as a check that proves nothing, in the one
 * place a user goes when something is already wrong.
 */
const COMMON_FLAGS: Record<string, Arity> = {
  help: "boolean",
  h: "boolean",
  version: "boolean",
  V: "boolean",
  quiet: "boolean",
  q: "boolean",
  basecamp: "value",
  app: "value",
  "app-dir": "value",
};

/** Flags shared by the commands that actually launch and drive an app. */
const BOOT_FLAGS: Record<string, Arity> = {
  "user-dir": "value",
  "reset-user-dir": "boolean",
  "keep-staged": "boolean",
  "real-home": "boolean",
  "wallet-password": "value",
  with: "value",
  port: "value",
  headed: "boolean",
  attach: "optional",
  "logs-dir": "value",
  env: "value",
  variant: "value",
  timeout: "value",
  // Every verb that opens an app can be blocked by the app's login screen, so
  // every one of them takes a profile. These used to be smoke's alone, which
  // meant a written spec had to duplicate the gate walkthrough and `init` could
  // not scaffold past a gate at all.
  setup: "value",
  "no-setup": "boolean",
};

/**
 * Per-verb flags. A name here overrides COMMON_FLAGS, which is how `--json`
 * can be a boolean for `inspect` and take a filename for `run`.
 */
const VERB_FLAGS: Record<string, Record<string, Arity>> = {
  smoke: {
    ...BOOT_FLAGS,
    limit: "value",
    settle: "value",
    skip: "value",
    "ignore-calls": "value",
    report: "value",
    "no-report": "boolean",
    junit: "value",
    json: "value",
    strict: "boolean",
  },
  // debug and breakpoint live here alone: the crawl has no step boundaries to
  // pause at, and inspect/init/doctor do not run a spec.
  run: {
    ...BOOT_FLAGS,
    junit: "value",
    json: "value",
    artifacts: "value",
    strict: "boolean",
    debug: "boolean",
    breakpoint: "value",
  },
  inspect: { ...BOOT_FLAGS, json: "boolean", hidden: "boolean" },
  init: { ...BOOT_FLAGS, force: "boolean", out: "value" },
  // doctor reads only these. It boots an app solely for --deep, using the app
  // and basecamp it was given; nothing else would change what it reports.
  doctor: { deep: "boolean", "set-basecamp": "value" },
};

export const KNOWN_VERBS = ["smoke", "run", "inspect", "init", "doctor"] as const;

function arityOf(verb: string, name: string): Arity | undefined {
  return VERB_FLAGS[verb]?.[name] ?? COMMON_FLAGS[name];
}

/** Edit distance, capped — just enough for a did-you-mean. */
function near(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

export class ArgError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "ArgError";
  }
}

function rejectUnknown(verb: string, name: string): never {
  const here = Object.keys({ ...COMMON_FLAGS, ...(VERB_FLAGS[verb] ?? {}) });
  const suggestion = here
    .map((k) => [k, near(name, k)] as const)
    .filter(([, d]) => d <= 2)
    .sort((x, y) => x[1] - y[1])[0]?.[0];

  const elsewhere = Object.entries(VERB_FLAGS)
    .filter(([v, table]) => v !== verb && name in table)
    .map(([v]) => v);

  if (elsewhere.length > 0) {
    const extra =
      name === "debug" || name === "breakpoint"
        ? " The crawl has no step boundaries to pause at — write a spec with `sitometres init <app>` first."
        : "";
    throw new ArgError(
      `--${name} does not mean anything for \`${verb}\``,
      `It is a flag for: ${elsewhere.join(", ")}.${extra}`,
    );
  }
  throw new ArgError(
    `unknown flag --${name}`,
    suggestion ? `Did you mean --${suggestion}?` : "Run `sitometres --help` for the full list.",
  );
}

/**
 * Read a command line.
 *
 * Exported so the arity table can be tested without launching anything —
 * every defect this fixes was invisible to a suite that could not call it.
 */
/**
 * Is this flag value-taking wherever it appears?
 *
 * Used only by the verb scan, which runs before the verb — and therefore the
 * arity table — is known. Anything ambiguous (--json is boolean for inspect and
 * value-taking for run) is deliberately NOT treated as value-taking here: the
 * scan may then look at a token it should have skipped, which costs nothing
 * because that token still has to BE a verb name to be chosen.
 */
function alwaysTakesValue(name: string): boolean {
  const common = COMMON_FLAGS[name];
  if (common !== undefined) return common === "value";
  const arities = Object.values(VERB_FLAGS)
    .map((table) => table[name])
    .filter((a): a is Arity => a !== undefined);
  return arities.length > 0 && arities.every((a) => a === "value");
}

/**
 * Which command this line is running.
 *
 * Scanning for the FIRST bare token was wrong, because a value-taking flag's
 * value is a bare token: `--port 9000 inspect --json` picked "9000", resolved
 * arity against smoke, and then rejected --json as needing a value. Worse,
 * `--port 9000 inspect --json medusa_ui` resolved --json as value-taking and
 * silently ate the app name — the same class of bug the arity table was added
 * to eliminate, reintroduced for flags written before the verb.
 *
 * A bare token is a candidate only if it is a known verb AND is not the value
 * of an unambiguously value-taking flag, so `--app run` still names an app.
 */
function resolveVerb(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a.startsWith("-") && a !== "-") {
      const name = a.replace(/^--?/, "").split("=")[0]!;
      // Its value is the next token only when it was not given inline.
      if (!a.includes("=") && alwaysTakesValue(name)) i++;
      continue;
    }
    if ((KNOWN_VERBS as readonly string[]).includes(a)) return a;
  }
  return "smoke";
}

/**
 * Flags that are individually valid but meaningless together.
 *
 * Part of parseArgs, not of the dispatch below it, so it can be tested: the
 * previous version of this check lived inside `main()`'s `run` case, where no
 * test could reach it — which is the same class of defect it exists to prevent.
 *
 * `--breakpoint` without `--debug` parsed, was stored, and was then discarded,
 * because the debug context is built only when `--debug` is set. So the spec
 * ran straight past the step the user asked to stop at, with no diagnostic,
 * while `--help` said "requires --debug" and nothing enforced it. That is the
 * flag-that-does-nothing defect already fixed for `smoke --debug`, one flag over.
 */
export function checkCombinations(verb: string, flags: Map<string, string | true>): void {
  if (verb === "run" && flags.has("breakpoint") && !flags.has("debug")) {
    throw new ArgError(
      "--breakpoint needs --debug",
      "Pausing happens in debug mode. Try `sitometres run <spec> --debug --breakpoint <n>`.",
    );
  }
  if (flags.has("setup") && flags.has("no-setup")) {
    throw new ArgError(
      "--setup and --no-setup contradict each other",
      "Name a profile, or skip the one that would be discovered — not both.",
    );
  }
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  const positional: string[] = [];

  const verb = resolveVerb(argv);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-") || a === "-") {
      positional.push(a);
      continue;
    }
    // `--` ends flag parsing; everything after it is positional.
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    let name = a.replace(/^--?/, "");
    let inlineValue: string | undefined;
    const eq = name.indexOf("=");
    if (eq > 0) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    const arity = arityOf(verb, name);
    if (arity === undefined) rejectUnknown(verb, name);

    if (arity === "boolean") {
      if (inlineValue !== undefined) {
        throw new ArgError(`--${name} does not take a value`, `Got --${name}=${inlineValue}.`);
      }
      flags.set(name, true);
      continue;
    }

    const next = argv[i + 1];
    const takesNext = inlineValue === undefined && next !== undefined && (!next.startsWith("-") || next === "-");
    const value = inlineValue ?? (takesNext ? next : undefined);

    if (value === undefined) {
      if (arity === "optional") {
        flags.set(name, true);
        continue;
      }
      throw new ArgError(`--${name} needs a value`, `e.g. --${name} <value>`);
    }
    if (takesNext) i++;
    flags.set(name, value);
    const prev = repeated.get(name) ?? [];
    prev.push(value);
    repeated.set(name, prev);
  }

  checkCombinations(verb, flags);

  // Strip the verb wherever it appeared, so what is left is purely positional.
  const verbAt = positional.indexOf(verb);
  const bare = verbAt >= 0 ? [...positional.slice(0, verbAt), ...positional.slice(verbAt + 1)] : positional;
  return { verb, command: bare[0], positional: bare.slice(1), flags, repeated };
}

/** Parse repeated `--env KEY=VALUE` into an environment overlay. */
function envOverlay(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    if (eq <= 0) throw new Error(`--env expects KEY=VALUE, got ${JSON.stringify(v)}`);
    out[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return out;
}

function num(v: string | true | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function list(v: string | true | undefined): string[] | undefined {
  return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Setup-profile options, identical for every verb that opens an app. */
function setupOpts(flags: Map<string, string | true>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const setup = str(flags.get("setup"));
  if (setup) o.setup = setup;
  if (flags.has("no-setup")) o.noSetup = true;
  return o;
}

function fsExistsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a command line and run it.
 *
 * `argv` and `deps` are parameters so this can be called in-process. It used to
 * read `process.argv` and call `boot` through each command, which put the whole
 * of dispatch — which verb runs, which options each one is handed, what the
 * exit code becomes — behind a real Basecamp. A test could reach `parseArgs`
 * and nothing after it.
 */
export async function main(argv: string[] = process.argv.slice(2), deps: CommandDeps = REAL_DEPS): Promise<number> {
  const { verb, command, positional, flags, repeated } = parseArgs(argv);

  if (flags.has("help") || flags.has("h") || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (flags.has("version") || flags.has("V")) {
    console.log(VERSION);
    return 0;
  }

  // `sitometres` and `sitometres <app>` both mean smoke; anything else is a
  // command, and may still be followed by an app name. parseArgs already
  // resolved the verb — reusing its answer is what keeps dispatch and arity
  // from disagreeing, which is how a flag could be parsed for one command and
  // then handed to another.
  const rest = [command, ...positional].filter((x): x is string => Boolean(x));

  // Shared boot options.
  const common: Record<string, unknown> = {};
  let cwd = str(flags.get("app-dir"));
  let app = str(flags.get("app"));

  // A bare positional is an app name, unless it is a directory that exists.
  const target = verb === "run" ? rest[1] : rest[0];
  if (target && app === undefined && cwd === undefined) {
    if (fsExistsDir(target)) cwd = target;
    else app = target;
  }
  if (cwd) common.cwd = cwd;
  if (app) common.app = app;

  // No wallet question is asked. Basecamp already holds the developer's wallet
  // configuration; the only reason a run sees none is that sitometres sandboxes
  // $HOME, and --real-home is the one lever that changes it. A password is
  // needed solely to unlock an encrypted wallet, and only if a test needs it
  // unlocked, so it stays an explicit opt-in rather than a prompt on every run.
  const walletPassword = str(flags.get("wallet-password")) ?? process.env.SITOMETRES_WALLET_PASSWORD;
  Object.assign(common, homeAndWallet(flags.has("real-home"), walletPassword));
  const withApps = list(flags.get("with"));
  if (withApps) common.with = withApps;
  const basecamp = str(flags.get("basecamp"));
  if (basecamp) common.basecamp = basecamp;
  const userDir = str(flags.get("user-dir"));
  if (userDir) common.userDir = userDir;
  if (flags.has("reset-user-dir")) common.resetUserDir = true;
  if (flags.has("keep-staged")) common.keepStaged = true;
  const port = num(flags.get("port"));
  if (port !== undefined) common.port = port;
  const timeout = num(flags.get("timeout"));
  if (timeout !== undefined) common.timeoutMs = timeout;
  const variant = str(flags.get("variant"));
  if (variant) common.variant = variant;
  const env = envOverlay(repeated.get("env"));
  if (env) common.env = env;
  if (flags.has("headed")) common.headless = false;
  if (flags.has("attach")) {
    const attachPort = num(flags.get("attach"));
    const logsDir = str(flags.get("logs-dir"));
    common.attachTo = {
      ...(attachPort !== undefined ? { port: attachPort } : {}),
      ...(logsDir ? { logsDir } : {}),
    };
  }

  if (!flags.has("quiet") && !flags.has("q") && !flags.has("json")) printBanner(VERSION);

  // A run is long and mostly silent — staging, a Basecamp start, a plugin that
  // can take a minute to render. The status line is the heartbeat that says
  // what is happening right now; without it the tool looks hung.
  status.start("Preparing", "starting up");

  switch (verb) {
    case "doctor":
      return doctor({
        ...(cwd ? { cwd } : {}),
        ...(app ? { app } : {}),
        ...(basecamp ? { basecamp } : {}),
        ...(str(flags.get("set-basecamp")) ? { setBasecamp: str(flags.get("set-basecamp"))! } : {}),
        deep: flags.has("deep"),
      }, deps);

    case "smoke": {
      const o: Record<string, unknown> = { ...common };
      const limit = num(flags.get("limit"));
      if (limit !== undefined) o.limit = limit;
      const settle = num(flags.get("settle"));
      if (settle !== undefined) o.settleMs = settle;
      const skip = list(flags.get("skip"));
      const ignoreCalls = list(flags.get("ignore-calls"));
      if (ignoreCalls) o.ignoreCalls = ignoreCalls;
      const smokeJunit = str(flags.get("junit"));
      if (smokeJunit) o.junit = smokeJunit;
      const smokeJson = str(flags.get("json"));
      if (smokeJson) o.json = smokeJson;
      if (flags.has("strict")) o.strict = true;
      if (skip) o.skip = skip;
      const report = str(flags.get("report"));
      if (report) o.report = report;
      if (flags.has("no-report")) o.noReport = true;
      Object.assign(o, setupOpts(flags));
      // The crawl has no pause points: it never consults session.debug, and its
      // only Runner is the setup profile — so --breakpoint 4 used to pause
      // before SETUP step 4, which is not what anyone asked for. Advertising a
      // flag that does nothing is the same defect as a check that proves
      // nothing, so it is refused rather than ignored.
      return smoke(o, deps);
    }

    case "inspect":
      return inspect({ ...common, ...setupOpts(flags), hidden: flags.has("hidden"), json: flags.has("json") }, deps);

    case "init": {
      const o: Record<string, unknown> = { ...common, ...setupOpts(flags), force: flags.has("force") };
      const out = str(flags.get("out"));
      if (out) o.out = out;
      return init(o, deps);
    }

    case "run": {
      const specPath = rest[0];
      if (!specPath) {
        console.error("  run needs a spec file: sitometres run <spec.yaml>");
        return 1;
      }
      const o: Record<string, unknown> = { ...common, ...setupOpts(flags), specPath };
      const json = str(flags.get("json"));
      if (json) o.json = json;
      const junit = str(flags.get("junit"));
      if (junit) o.junit = junit;
      const artifacts = str(flags.get("artifacts"));
      if (artifacts) o.artifactDir = artifacts;
      if (flags.has("debug")) o.debug = true;
      if (flags.has("strict")) o.strict = true;
      const breakpoint = num(flags.get("breakpoint"));
      if (breakpoint !== undefined) o.breakpoint = breakpoint;
      return run(o as unknown as Parameters<typeof run>[0], deps);
    }

    default:
      console.error(`  unknown command "${command}"\n${USAGE}`);
      return 1;
  }
}

/**
 * Run only when this file IS the command, not when it is imported.
 *
 * It used to execute on import, which meant nothing inside it could be tested:
 * importing the module to reach parseArgs launched a whole run instead. That is
 * why the argument parser — including a flag-arity bug that could point a run
 * at the developer's real $HOME — had no tests at all.
 */
const isEntryPoint = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) cliMain();

/**
 * The process wrapper: run, print whatever went wrong, and set the exit code.
 *
 * `exit` is a parameter so the error-rendering below can be exercised. It was
 * a direct `process.exit`, which meant every branch of it — the one that turns
 * an ArgError into two readable lines rather than a stack trace — could only be
 * reached by ending the process.
 */
export function cliMain(
  argv: string[] = process.argv.slice(2),
  deps: CommandDeps = REAL_DEPS,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  main(argv, deps)
  .then((code) => {
    status.stop(code === 0 ? "Completed" : "Failed");
    exit(code);
  })
  .catch((err: unknown) => {
    status.stop("Failed");
    // Every error class we raise carries something the developer can act on;
    // print that rather than a stack trace they cannot use.
    if (err instanceof ArgError) {
      console.error(`\n  \x1b[31mx\x1b[0m ${err.message}`);
      if (err.hint) console.error(`    \x1b[2m${err.hint}\x1b[0m\n`);
    } else if (err instanceof BootError) {
      console.error(`\n  \x1b[31mx\x1b[0m ${err.message}`);
      if (err.hint) console.error(`    \x1b[2m${err.hint}\x1b[0m\n`);
    } else if (err instanceof SpecError || err instanceof SelectorError) {
      console.error(`\n  \x1b[31mx\x1b[0m ${err.message}\n`);
    } else if (err instanceof InspectorTransportError) {
      console.error(`\n  \x1b[31mx\x1b[0m ${err.message}\n`);
    } else {
      console.error(`\n  \x1b[31mx\x1b[0m ${(err as Error).message ?? String(err)}\n`);
      if (process.env.SITOMETRES_DEBUG) console.error((err as Error).stack);
    }
    exit(1);
  });
}
