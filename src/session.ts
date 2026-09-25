// ---------------------------------------------------------------------------
// Getting from "a developer's repo" to "a live app under test".
//
// Shared by every command so `run`, `smoke` and `inspect` agree on what the
// app under test is, where Basecamp came from, and how much the logs can be
// trusted.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BasecampBinary,
  basecampUserDirs,
  compareCopies,
  type DiscoveredApp,
  discoverApps,
  discoverCopies,
  locateBasecamp,
  type PassReason,
  satisfiesRange,
  staleRememberedBasecamp,
} from "./app/discover.js";
import { displayArtifact, recordStaged, type StagedRecord } from "./app/fingerprint.js";
import { attach, launch, reapDirOnExit, releaseDir, type ReadySummary, type Session, type SessionMode } from "./app/lifecycle.js";
import { uiLabel } from "./app/manifest.js";
import { hostVariant, stageUserDir, type StagedUserDir } from "./app/userdir.js";
import { assessFidelity, type FidelityReport } from "./runner/fidelity.js";
import { status } from "./report/status.js";
import { detectWalletProvider, type WalletProvider } from "./app/wallet.js";
import { configPath, saveConfig } from "./config.js";
import { ask, canPrompt } from "./report/prompt.js";
import type { DebugContext } from "./runner/debug.js";
import type { LogCursor, LogLine } from "./logs/buffer.js";
import { CallWindowTracker } from "./logs/classify.js";
import {
  commandTimeoutFor,
  DEFAULT_ATTACH_TIMEOUT_MS,
  DEFAULT_CALL_WINDOW_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  type TimeoutFlags,
  timeoutFlagsOf,
} from "./timeouts.js";

export interface BootOptions extends TimeoutFlags {
  /** Where to look for the app. Defaults to cwd. */
  cwd?: string;
  /** Module name to test when the directory holds more than one app. */
  app?: string;
  /** Extra app names to stage alongside it. */
  with?: string[];
  basecamp?: string;
  headless?: boolean;
  userDir?: string;
  /** Clear a caller-supplied --user-dir before staging. See StageOptions.reset. */
  resetUserDir?: boolean;
  /**
   * Leave the staged build in a caller-supplied --user-dir when the run ends.
   *
   * Off by default: the run puts the user-dir back as it found it.
   */
  keepStaged?: boolean;
  port?: number;
  /** Attach to an already-running Basecamp instead of launching one. */
  attachTo?: { port?: number; logsDir?: string };
  variant?: string;
  /**
   * Startup readiness budget (--timeout). Also the budget for opening the app
   * when neither --open-timeout nor the spec names one. Infinity means none.
   */
  timeoutMs?: number;
  /**
   * Extra environment for the app under test. Merged over the sandbox.
   */
  env?: Record<string, string>;
  /**
   * Let the app see your real $HOME instead of a throwaway one.
   *
   * OFF by default, and that default is the whole reason `sitometres` needs no
   * per-app configuration. --user-dir only re-roots what Basecamp itself owns;
   * an app keeps its own state wherever it likes, and several resolve it from
   * $HOME (medusa_core's wallet lives at
   * $HOME/.local/share/medusa-wallet-home). Handing the app a fresh HOME
   * isolates all of that generically, without sitometres having to know any
   * particular app's environment variables.
   *
   * Turn it on when you deliberately want to test against your real data.
   */
  realHome?: boolean;
  /**
   * Resolved by the CLI before boot; see ../app/wallet.ts.
   *
   * `choice` follows `realHome` and nothing else — a password is for unlocking
   * a wallet, not for deciding which one the app sees. Conflating the two used
   * to mean `--wallet-password` silently un-sandboxed $HOME.
   */
  wallet?: { choice: "fresh" | "real"; password?: string };
  /** Enable interactive debug mode */
  debug?: boolean;
  /** Pause before step N (requires --debug) */
  breakpoint?: number;
}

export interface Boot {
  session: Session;
  ready: ReadySummary;
  fidelity: FidelityReport;
  app: DiscoveredApp | null;
  /** Every app staged, including dependencies. */
  staged: DiscoveredApp[];
  /**
   * How each staged copy was chosen, and every copy passed over. Null in
   * attach mode, which staged nothing. `doctor` computes the same plan without
   * launching anything; see planStaging.
   */
  plan: StagingPlan | null;
  /**
   * One record per staged app, the app under test first, each with a sha256
   * of the file Basecamp loads from the STAGED copy. Empty in attach mode.
   */
  stagedRecords: StagedRecord[];
  /** The throwaway $HOME given to the app, or null when the real one is in use. */
  sandboxHome: string | null;
  /**
   * The $HOME the app was ACTUALLY given, sandboxed or not — what `file:`
   * expectations resolve against. Null only in attach mode. See appHomeFor.
   */
  appHome: string | null;
  /** One line describing the wallet identity, for the report header. */
  walletSummary: string | null;
  /**
   * How to unlock the wallet once the app is open, when a password was given.
   *
   * Unlocking needs the app's QML root, which does not exist until after the
   * open step, so boot cannot do it — it hands back what the caller needs.
   */
  walletUnlock: { provider: WalletProvider; password: string } | null;
  basecamp: BasecampBinary | null;
  userDir: StagedUserDir | null;
  /** Debug context for interactive debugging */
  debug?: DebugContext;
  /**
   * The time budgets this boot was given, so a setup profile run against it
   * inherits them. Absent from a boot built by hand, which then gets defaults.
   */
  timeouts?: TimeoutFlags;
  dispose(): Promise<void>;
}

export class BootError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "BootError";
  }
}

/**
 * The one piece of the world a command cannot supply for itself.
 *
 * Every verb begins `await boot(opts)` — stage an app, launch Basecamp, wait
 * for it — and that single line put each command's whole body behind a real
 * binary. So nothing tested any of them: the crawl's exit code, its five
 * artifact-emitting exits and its crash attribution were reachable only by
 * launching an app, which is how the CI-gate regression of 73b8008 shipped past
 * a green suite and why the sweep ended up "verified" by a regex over its own
 * source text.
 *
 * CONTRIBUTING already prescribes the move: "If you cannot test something
 * without launching an app, that is usually a sign the logic wants extracting
 * — `parseArgs` and `homeAndWallet` were both untestable until they were moved
 * out of a module that ran on import." This is the same extraction one level
 * up. A caller passes nothing and gets the real thing; a test passes a session
 * it built itself.
 */
export interface CommandDeps {
  boot: (opts: BootOptions) => Promise<Boot>;
}

/** What every command uses unless a caller says otherwise. */
export const REAL_DEPS: CommandDeps = { boot: (opts) => boot(opts) };

/**
 * Pick the app under test.
 *
 * A UI test needs something with a UI, so a lone core module is an error with
 * a pointed message rather than a confusing empty run.
 */
export function selectApp(candidates: DiscoveredApp[], wanted?: string): DiscoveredApp {
  if (candidates.length === 0) {
    throw new BootError(
      "no Logos app found here",
      "sitometres looks for plugins/<name>/, modules/<name>/, a metadata.json at the root, or a built .lgx. " +
        "Run it from your module repo, or pass --app-dir.",
    );
  }
  if (wanted) {
    const hit = candidates.find((c) => c.manifest.name === wanted);
    if (!hit) {
      // UI apps first: those are the ones you can actually drive.
      const names = [...new Set(
        [...candidates].sort((a, b) => Number(b.slot === "plugins") - Number(a.slot === "plugins"))
          .map((c) => c.manifest.name),
      )];
      throw new BootError(
        `no app called "${wanted}" found`,
        `Looked in this directory and your Basecamp install. Available: ${names.join(", ")}`,
      );
    }
    // The same guard as the auto-select path below. Naming a core module used
    // to skip it, burn the full open budget waiting for a dock that can never
    // exist, and then fail with a staging message that was also wrong.
    if (hit.slot !== "plugins") {
      throw new BootError(
        `"${hit.manifest.name}" is a core module with no UI`,
        "sitometres drives user interfaces. Point it at the ui_qml plugin that consumes this module, " +
          "and stage this one alongside it with --with " + hit.manifest.name + ".",
      );
    }
    return hit;
  }
  const uiApps = candidates.filter((c) => c.slot === "plugins");
  if (uiApps.length === 1) return uiApps[0]!;
  if (uiApps.length === 0) {
    throw new BootError(
      `"${candidates[0]!.manifest.name}" is a core module with no UI`,
      "sitometres drives user interfaces. Point it at the ui_qml plugin that consumes this module.",
    );
  }
  throw new BootError(
    `found ${uiApps.length} UI apps here`,
    `choose one with --app: ${uiApps.map((c) => c.manifest.name).join(", ")}`,
  );
}

export async function boot(opts: BootOptions = {}): Promise<Boot> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());

  // --- attach mode: the developer already has Basecamp running -------------
  if (opts.attachTo) {
    const session = attach({ ...opts.attachTo, commandTimeoutMs: outsideCommandTimeout(opts) });
    const ready = await session.waitUntilReady({ timeoutMs: opts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS });
    
    // Initialize debug context if debug mode is enabled (even in attach mode)
    const debugContext: DebugContext | undefined = opts.debug ? {
      active: false,
      stepNumber: 0,
      stepDescription: "",
      isBreakpoint: false,
      isFailure: false,
      breakpointStep: opts.breakpoint,
    } : undefined;
    
    if (debugContext) {
      session.debug = debugContext;
    }
    
    return {
      session,
      ready,
      // Attached sessions read log FILES. 0.2.2 flushes them only on rotation
      // or exit; 0.3.0 flushes every line, but nothing here can tell whether
      // that instance was started with its Qt logging routed to the file at
      // all. So we never claim the log is authoritative here.
      fidelity: {
        fidelity: "quiet",
        qtLogLines: 0,
        moduleLogLines: 0,
        summary: "Attached to a running Basecamp; its live stdout is not available to us.",
        remedy:
          "Log-based assertions read the on-disk log instead, and whether that Basecamp was started with " +
          "its Qt logging reaching the file cannot be checked from here (0.2.2 also flushes the file only " +
          "on rotation or exit), so they are reported INCONCLUSIVE. Let sitometres launch the app to get " +
          "live evidence.",
      },
      app: null,
      staged: [],
      plan: null,
      stagedRecords: [],
      basecamp: null,
      userDir: null,
      sandboxHome: null,
      appHome: appHomeFor(null, session.mode),
      walletSummary: null,
      // Attach mode drives someone else's process; sitometres neither chose
      // its wallet nor can unlock one on its behalf.
      walletUnlock: null,
      debug: debugContext,
      timeouts: timeoutFlagsOf(opts),
      async dispose() {
        await session.stop();
      },
    };
  }

  // --- owned mode ----------------------------------------------------------
  // Look in the working directory first, then in the developer's Basecamp
  // install, so `sitometres <app>` works from anywhere without a --app-dir.
  status.set("Preparing", `looking for an app in ${short(cwd)}`);
  const plan = planStaging({
    cwd,
    ...(opts.app !== undefined ? { app: opts.app } : {}),
    ...(opts.with !== undefined ? { with: opts.with } : {}),
    ...(opts.variant !== undefined ? { variant: opts.variant } : {}),
    onProgress: (detail) => status.set("Preparing", detail),
  });
  const { app, staged } = plan;

  let binaries = locateBasecamp(opts.basecamp);
  let basecamp = binaries.find((b) => b.inspectorEnabled);

  if (!basecamp && !opts.basecamp && canPrompt()) {
    // Where Basecamp lives is the one thing that genuinely varies per machine
    // and cannot be derived. Ask once, then remember it.
    // suspend(), not clear(): clear() erases once and leaves the 100 ms ticker
    // running, so the question was wiped about a tenth of a second after it
    // appeared and the user was left typing at an invisible prompt.
    status.suspend();
    console.log(`\n  No Basecamp with the QML inspector was found automatically.`);
    const answer = (await ask("Path to your Basecamp binary (blank to give up):")).trim();
    if (answer) {
      const resolved = path.resolve(answer.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
      binaries = locateBasecamp(resolved);
      basecamp = binaries.find((b) => b.inspectorEnabled);
      if (basecamp) {
        const file = saveConfig({ basecamp: resolved });
        console.log(`  remembered — future runs will use it (${file})\n`);
      }
    }
    status.resume();
  }

  if (!basecamp) {
    const explicit = opts.basecamp ?? process.env.SITOMETRES_BASECAMP ?? process.env.LOGOS_BASECAMP_BIN;
    const found = binaries.length
      ? `${binaries.map((b) => b.path).join(", ")} ${binaries.length === 1 ? "has" : "have"} no inspector.`
      : explicit
        ? describeUnusable(explicit)
        : "No Basecamp binary found.";
    throw new BootError(
      "no Basecamp with the QML inspector compiled in",
      `${found} ` +
        (staleRememberedBasecamp
          ? `The remembered path ${staleRememberedBasecamp} is gone or not executable — fix it with ` +
            `sitometres doctor --set-basecamp <path>, or edit ${configPath()}. `
          : "") +
        `The inspector is a compile-time feature and is OFF in release builds. ` +
        `Build one with: cd logos-basecamp && nix build .#default   (or .#bin-bundle-dir-inspector), ` +
        `then pass --basecamp <path> or set $SITOMETRES_BASECAMP.`,
    );
  }

  const stageOpts: Parameters<typeof stageUserDir>[1] = {};
  if (opts.userDir) stageOpts.userDir = opts.userDir;
  if (opts.variant) stageOpts.variant = opts.variant;
  if (opts.resetUserDir) stageOpts.reset = true;
  if (opts.keepStaged) stageOpts.keepStaged = true;
  status.set(
    "Preparing",
    `staging ${staged.map((x) => x.manifest.name).join(", ")} into ` +
      (opts.userDir ? "the user-dir you named" : "a throwaway user-dir"),
  );
  const userDir = stageUserDir(staged, stageOpts);

  // Hashed now, after staging and before launch: the bytes Basecamp is about to
  // load, read from where it will load them. Hashing the source instead would
  // hide the one failure worth catching, a copy that is not what was chosen.
  status.set("Preparing", "hashing what was staged");
  const variant = opts.variant ?? hostVariant();
  const notesByName = notesFor(plan);
  const stagedRecords = staged.map((s) => {
    const record = recordStaged(s, userDir.root, variant);
    const note = notesByName.get(s.manifest.name);
    return note ? { ...record, note } : record;
  });

  // --real-home is the ONE lever that decides this. A wallet password used to
  // be folded in here, which meant passing one silently handed the app the
  // developer's real $HOME — the opposite of what its help text promised.
  const useRealHome = opts.realHome === true;
  if (!useRealHome) status.set("Preparing", "creating a throwaway HOME so app data stays private to this run");
  const sandbox = useRealHome ? null : makeSandboxHome();
  // Hoisted because appHome is derived from it, not from the sandbox root.
  // `--env HOME=…` lands in opts.env and wins here, so a sandbox root read on
  // its own names a directory the app was never given.
  const appEnv = { ...(sandbox?.env ?? {}), ...(opts.env ?? {}) };
  const launchOpts: Parameters<typeof launch>[0] = {
    binary: basecamp.path,
    userDir: userDir.root,
    headless: opts.headless !== false,
    env: appEnv,
    commandTimeoutMs: outsideCommandTimeout(opts),
  };
  if (opts.port !== undefined) launchOpts.port = opts.port;
  // A caller's user-dir whose config.yaml switched the stdout mirror off still
  // writes its log file, flushed per line: read that instead of reporting a
  // silent Basecamp and blaming QT_FORCE_STDERR_LOGGING for it.
  const logging = userDir.loggingConfig;
  if (logging && logging.enabled && !logging.console && !logging.problem) {
    launchOpts.tailLogs = { dir: logging.dir, file: logging.file };
  }
  status.set("Preparing", `launching Basecamp${opts.headless === false ? "" : " (offscreen)"}`);
  const session = await launch(launchOpts);

  let ready: ReadySummary;
  try {
    ready = await session.waitUntilReady({ timeoutMs: opts.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS });
  } catch (err) {
    await session.stop();
    userDir.cleanup();
    sandbox?.cleanup();
    throw err;
  }

  status.set("Preparing", "checking what this build's logs will show");
  const fidelity = assessFidelity(
    session.logs,
    logging && !logging.problem
      ? { logging: { enabled: logging.enabled, console: logging.console, configPath: logging.path } }
      : {},
  );

  // Initialize debug context if debug mode is enabled
  const debugContext: DebugContext | undefined = opts.debug ? {
    active: false,
    stepNumber: 0,
    stepDescription: "",
    isBreakpoint: false,
    isFailure: false,
    breakpointStep: opts.breakpoint,
  } : undefined;

  if (debugContext) {
    session.debug = debugContext;
  }

  return {
    session,
    ready,
    fidelity,
    app,
    staged,
    plan,
    stagedRecords,
    basecamp,
    userDir,
    sandboxHome: sandbox?.root ?? null,
    appHome: appHomeFor(sandbox?.root ?? null, session.mode, appEnv),
    walletSummary: describeWallet(app, staged, useRealHome),
    walletUnlock: unlockPlan(app, staged, opts.wallet?.password),
    debug: debugContext,
    timeouts: timeoutFlagsOf(opts),
    async dispose() {
      await session.stop();
      userDir.cleanup();
      sandbox?.cleanup();
    },
  };
}

/**
 * The deadline for an inspector command issued outside any spec step: the
 * readiness probe, an open, a crawl's clicks and snapshots.
 *
 * --command-timeout, else the bridge window (--call-timeout, else the stock
 * 20 s) plus a margin. A spec step resolves its own; see Runner.budgetFor.
 */
export function outsideCommandTimeout(opts: TimeoutFlags): number {
  return opts.commandTimeoutMs ?? commandTimeoutFor(opts.callTimeoutMs ?? DEFAULT_CALL_WINDOW_MS);
}

/**
 * Keeps the deadline of commands issued outside any spec step on the bridge
 * window the log has shown so far.
 *
 * Boot sets that deadline from the flags alone, before the app has logged a
 * single dispatch. A Basecamp built with a longer window prints it on every
 * synchronous dispatch line, and what runs after those lines (an open, a
 * wallet unlock, which is itself a synchronous backend call, a crawl's
 * clicks) has to be allowed that window, or a call the bridge would still
 * answer is reported as a hung app. --command-timeout, when given, is the
 * deadline outright and is left alone.
 */
export class OutsideDeadline {
  private readonly windows = new CallWindowTracker();

  constructor(
    private readonly session: { inspector: { commandTimeoutMs: number }; logs: { slice(from: LogCursor): LogLine[] } },
    private readonly flags: TimeoutFlags,
  ) {}

  /** --call-timeout, else the largest window the log has shown, else the stock 20 s. */
  callWindow(): number {
    if (this.flags.callTimeoutMs !== undefined) return this.flags.callTimeoutMs;
    const logs = this.session.logs;
    const learned = typeof logs?.slice === "function" ? this.windows.observe(logs) : null;
    return learned ?? DEFAULT_CALL_WINDOW_MS;
  }

  /**
   * Read whatever the log added, and move the inspector's deadline with it.
   *
   * A window learned from the log only ever raises the deadline above boot's.
   * Not every dispatch carries the bridge's window: Basecamp gives a call to a
   * module that is still starting a short budget of its own (1.5 s) on the
   * same line, and a deadline cut to that would report an ordinary slow reply
   * as a hung app. A declared --call-timeout is taken as it is.
   */
  follow(): number {
    if (this.flags.commandTimeoutMs !== undefined) return this.flags.commandTimeoutMs;
    const window = this.callWindow();
    const floor = this.flags.callTimeoutMs !== undefined ? window : Math.max(window, DEFAULT_CALL_WINDOW_MS);
    const ms = outsideCommandTimeout({ callTimeoutMs: floor });
    this.session.inspector.commandTimeoutMs = ms;
    return ms;
  }
}

/**
 * Directories under $HOME that hold TOOLS rather than data.
 *
 * A blank $HOME isolates an app's data perfectly and then breaks it: medusa_ui
 * shells out to $HOME/.local/bin/medusa-wallet, and in a bare sandbox it
 * reports "This binary is missing, so no wallet operation can run". Linking
 * these through keeps executables discoverable while everything stateful —
 * .local/share, .config, .cache — stays private to the run.
 */
const TOOL_DIRS = [".local/bin", "bin", ".nix-profile", ".cargo/bin", ".npm-global/bin"];

/**
 * A throwaway $HOME for the app under test.
 *
 * XDG_* are set alongside it because Qt reads those in preference to $HOME on
 * Linux; leaving them pointing at the real home would let QStandardPaths
 * escape the sandbox even though $HOME did not.
 */
export function makeSandboxHome(): { root: string; env: Record<string, string>; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sitometres-home-"));
  // Ctrl-C used to reap the processes and leave this behind.
  reapDirOnExit(root);
  for (const sub of [".local/share", ".config", ".cache"]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }

  const realHome = process.env.HOME ?? os.homedir();
  for (const rel of TOOL_DIRS) {
    const from = path.join(realHome, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(root, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // A symlink, NOT a read-only mount: the app can run these AND write
      // through them to the real directory. Verified — an app writing to
      // $SANDBOX/.local/bin/x replaces the real ~/.local/bin/x. Data under
      // .local/share, .config and .cache is genuinely private to the run;
      // executables are shared, and the docs say so rather than promising
      // a guarantee a symlink cannot give.
      fs.symlinkSync(from, to, "dir");
    } catch {
      /* a tool dir we cannot link is not worth failing the run over */
    }
  }
  return {
    root,
    env: {
      HOME: root,
      XDG_DATA_HOME: path.join(root, ".local/share"),
      XDG_CONFIG_HOME: path.join(root, ".config"),
      XDG_CACHE_HOME: path.join(root, ".cache"),
      XDG_STATE_HOME: path.join(root, ".local/state"),
    },
    cleanup() {
      releaseDir(root);
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing a run over */
      }
    },
  };
}

/**
 * The $HOME the app under test was given — what `file:` resolves against.
 *
 * Not the same question as `sandboxHome`, which is null in two situations that
 * must not be confused. Under --real-home the app really does see the
 * developer's own $HOME (launch() merges the sandbox env over process.env, so
 * with no sandbox the child inherits ours), and a spec written against $HOME
 * keeps working. In attach mode sitometres chose nothing, so the honest answer
 * is null and `file:` reports INCONCLUSIVE rather than resolving a path against
 * a directory the app never saw.
 *
 * Extracted rather than inlined into boot() for the reason CONTRIBUTING gives:
 * the --real-home arm is otherwise reachable only by launching an app against
 * the developer's real home, which is the one thing the suite must not do.
 */
export function appHomeFor(
  sandboxRoot: string | null,
  mode: SessionMode,
  env: Record<string, string> = {},
): string | null {
  if (mode === "attached") return null;
  // `env` first, and this order is the whole point: boot merges opts.env OVER
  // the sandbox's own, and launch applies that over process.env, so `--env
  // HOME=…` really is the $HOME the child got. Reading the sandbox root alone
  // made `file:` stat a directory the app never wrote to and call the app
  // wrong for it — a red verdict about the runner's own bookkeeping.
  return env.HOME ?? sandboxRoot ?? process.env.HOME ?? os.homedir();
}

/**
 * Why a path the user named cannot be used.
 *
 * "does not exist" was printed for anything unusable, including a file that is
 * there but not executable and a directory — and the remedy offered was to
 * rebuild Basecamp, which fixes neither.
 */
function describeUnusable(p: string): string {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return `${p} is a directory, not the Basecamp binary.`;
    return `${p} exists but is not executable (chmod +x it, or point at the real binary).`;
  } catch {
    return `${p} does not exist.`;
  }
}

// Moved to discovery, which needs it to tell an installed copy from a local
// one. Re-exported so `doctor` and every existing import keep working.
export { basecampUserDirs };

/** Apps already installed into a Basecamp on this machine. */
export function installedApps(): DiscoveredApp[] {
  const out: DiscoveredApp[] = [];
  for (const d of basecampUserDirs()) {
    if (!fs.existsSync(d)) continue;
    out.push(...discoverApps(d));
  }
  return out;
}

export interface StagingOptions {
  /** Where to look for the app. Defaults to cwd. */
  cwd?: string;
  /** Module name to test when the directory holds more than one app. */
  app?: string;
  /** Extra app names to stage alongside it. */
  with?: string[];
  /** Platform variant a `.lgx` will be unpacked for. Accepted for symmetry with boot. */
  variant?: string;
  /** Where to say what is happening; boot points this at the status line. */
  onProgress?: (detail: string) => void;
}

/** One name's choice: the copy that will be staged, and every copy that lost to it. */
export interface StagingDecision {
  name: string;
  chosen: DiscoveredApp;
  passedOver: Array<{ copy: DiscoveredApp; reason: PassReason }>;
}

export interface StagingPlan {
  /** The app under test. */
  app: DiscoveredApp;
  /** Everything to stage, the app under test first. */
  staged: DiscoveredApp[];
  /** One decision per staged name, in the same order. */
  decisions: StagingDecision[];
}

/**
 * Decide which copy of the app, and of each dependency, a run stages.
 *
 * Discovery, selection and dependency resolution, and nothing else: no
 * Basecamp binary, no staging, no launch. `boot` stages what this returns and
 * `doctor` prints it, so `doctor` cannot predict an artifact the run would not
 * stage. Every choice between two copies goes through compareCopies, the one
 * comparison, and every copy that lost is kept with the reason it lost.
 *
 * Where it looks, in order, which is also the order ties are broken in:
 *
 *   1. the working directory
 *   2. the Basecamp install, when the app under test is not in (1)
 *   3. for the app's dependencies and `with:` names only, the Basecamp install
 *      and the parent directory, because a UI plugin in one repo and its core
 *      module in a sibling is the common layout
 *
 * The sweep in (3) never replaces the app under test. `selectApp` has already
 * chosen it from what was found where the user pointed, and a developer
 * testing from their repo means their build. The parent directory reaches
 * every SIBLING project, and a sibling holding a plugin of the same name (a
 * fork, a second checkout, a copy) used to be staged in its place.
 *
 * Throws BootError for the same cases boot always has: no app, a core module
 * named as the app, an app or dependency that is not built, a dependency that
 * cannot be found.
 */
export function planStaging(opts: StagingOptions = {}): StagingPlan {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const decisions = new Map<string, StagingDecision>();
  /**
   * Version ranges the app under test declares for its dependencies (0.3.0's
   * object form). Known only once the app is chosen; a copy inside its range
   * beats one outside it, because 0.3.0 refuses to open an app whose
   * dependency is out of range.
   */
  const ranges = new Map<string, string>();
  const compareFor = (candidate: DiscoveredApp, incumbent: DiscoveredApp): { wins: boolean; reason: PassReason | null } => {
    const range = ranges.get(candidate.manifest.name);
    if (range !== undefined) {
      const a = satisfiesRange(candidate.manifest.version, range) === true;
      const b = satisfiesRange(incumbent.manifest.version, range) === true;
      if (a !== b) return { wins: a, reason: "out-of-range" };
    }
    return compareCopies(candidate, incumbent);
  };

  /** Weigh one more copy of a name against the one currently chosen. */
  const consider = (copy: DiscoveredApp): void => {
    const name = copy.manifest.name;
    const d = decisions.get(name);
    if (!d) {
      decisions.set(name, { name, chosen: copy, passedOver: [] });
      return;
    }
    // The same directory is often reached twice: $LOGOS_USER_DIR set to the
    // default install, or the parent sweep walking back into the working
    // directory. One copy found twice is not a choice.
    if ([d.chosen, ...d.passedOver.map((p) => p.copy)].some((c) => sameArtifact(c, copy))) return;
    const { wins, reason } = compareFor(copy, d.chosen);
    if (wins) {
      d.passedOver.push({ copy: d.chosen, reason: reason ?? "older" });
      d.chosen = copy;
    } else {
      d.passedOver.push({ copy, reason: reason ?? "older" });
    }
  };
  const chosenNow = (): DiscoveredApp[] =>
    [...decisions.values()]
      .map((d) => d.chosen)
      .sort((a, b) => Number(b.slot === "plugins") - Number(a.slot === "plugins"));

  for (const copy of discoverCopies(cwd)) consider(copy);
  let candidates = chosenNow();
  if (opts.app && !candidates.some((c) => c.manifest.name === opts.app)) {
    // Widen to the Basecamp install. A name found in both is decided by the
    // same comparison as everywhere else, so a local build of a dependency
    // still beats an installed copy of the same version.
    opts.onProgress?.(`"${opts.app}" is not here, so checking your Basecamp install`);
    for (const d of basecampUserDirs()) {
      if (!fs.existsSync(d)) continue;
      for (const copy of discoverCopies(d)) consider(copy);
    }
    candidates = chosenNow();
  }
  const app = selectApp(candidates, opts.app);

  if (app.incomplete) {
    throw new BootError(`"${app.manifest.name}" is not built`, `${app.incomplete}. Build it first, then run sitometres again.`);
  }

  // Ranges first, then every copy already weighed without them is weighed again.
  for (const spec of app.manifest.dependencySpecs ?? []) if (spec.version) ranges.set(spec.name, spec.version);
  for (const name of ranges.keys()) {
    const d = decisions.get(name);
    if (!d) continue;
    decisions.delete(name);
    for (const c of [d.chosen, ...d.passedOver.map((p) => p.copy)]) consider(c);
  }

  // Optional dependencies (0.3.0) are staged when they can be found, and are
  // never a reason to refuse the run: Basecamp opens the app without them.
  const optional = new Set((app.manifest.optional_dependencies ?? []).filter((n) => n !== app.manifest.name));
  const wanted = new Set<string>([app.manifest.name, ...app.manifest.dependencies, ...(opts.with ?? [])]);
  for (const n of wanted) optional.delete(n);
  opts.onProgress?.(`resolving ${app.manifest.name} and ${app.manifest.dependencies.length} dependency(ies)`);
  // Always consider the Basecamp install for a dependency, not only when the
  // local copy is missing: a complete-but-OLD artifact in dist/ would otherwise
  // beat a newer installed module purely by being found first.
  for (const dir of [...basecampUserDirs(), path.dirname(cwd)]) {
    for (const copy of discoverCopies(dir)) {
      if (!(wanted.has(copy.manifest.name) || optional.has(copy.manifest.name)) || copy.incomplete) continue;
      // Dependencies are worth hunting for; the app under test is not.
      if (copy.manifest.name === app.manifest.name) continue;
      consider(copy);
    }
  }

  const staged = [...wanted, ...optional]
    .map((n) => (n === app.manifest.name ? app : decisions.get(n)?.chosen))
    .filter((c): c is DiscoveredApp => c !== undefined)
    // An optional dependency found only as an unbuilt copy is left out, not an error.
    .filter((c) => !(optional.has(c.manifest.name) && c.incomplete));

  const stubs = staged.filter((s) => s.incomplete);
  if (stubs.length > 0) {
    const s0 = stubs[0]!;
    throw new BootError(
      `"${app.manifest.name}" needs "${s0.manifest.name}", and the only copy found is not built`,
      `${s0.incomplete}. Build that module, or point sitometres at a built copy. ` +
        `If it is already installed in Basecamp, sitometres will find it there automatically.`,
    );
  }

  const unresolved = [...wanted].filter((n) => !staged.some((s) => s.manifest.name === n));
  if (unresolved.length > 0) {
    throw new BootError(
      `"${app.manifest.name}" depends on ${unresolved.map((u) => `"${u}"`).join(", ")}, which could not be found`,
      `Looked in this repo, its parent, and your Basecamp install. Build the dependency, ` +
        `install it into Basecamp, or pass --with <name> once it exists on disk.`,
    );
  }

  // Each reason was recorded against whichever copy was chosen AT THE TIME,
  // and a later copy can displace that one. An .lgx that tied untimed with a
  // local directory, both then beaten by a higher installed version, kept its
  // "untimed-tie" and printed "the copy found first was kept" under a line
  // that staged neither. What a reader is told is why each copy lost to the
  // one actually staged, so every reason is weighed again against that copy.
  for (const d of decisions.values()) {
    for (const p of d.passedOver) {
      const again = compareFor(p.copy, d.chosen);
      if (!again.wins && again.reason) p.reason = again.reason;
    }
  }

  return {
    app,
    staged,
    decisions: staged.map((s) => decisions.get(s.manifest.name) ?? { name: s.manifest.name, chosen: s, passedOver: [] }),
  };
}

/**
 * The notes worth printing under a staged line, one line each.
 *
 * Two choices deserve a reader's attention, and only two. A local copy that
 * lost by version is the one exception to "your local build is what gets
 * tested", so it is named with its path. And a tie that build time could not
 * break was settled by discovery order, not by evidence, which a reader should
 * know before trusting that the newer build was the one staged.
 *
 * Each note starts with the app's name and a colon, which is how the header
 * and `doctor` place it under that app's line.
 */
export function stagingNotes(plan: StagingPlan): string[] {
  const out: string[] = [];
  for (const d of plan.decisions) {
    for (const p of d.passedOver) {
      const where = displayArtifact(p.copy.artifact);
      const v = p.copy.manifest.version ? ` ${p.copy.manifest.version}` : "";
      if (p.reason === "lower-version" && p.copy.provenance === "local") {
        out.push(
          `${d.name}: passed over the local${v} at ${where}, for a lower version than the ` +
            `${d.chosen.provenance} ${d.chosen.manifest.version ?? "copy"} staged`,
        );
      } else if (p.reason === "untimed-tie") {
        out.push(
          `${d.name}: passed over ${where} (${p.copy.provenance}, same version): the two could not be ` +
            `ordered by build time, so the copy found first was kept`,
        );
      } else if (p.reason === "out-of-range") {
        out.push(`${d.name}: passed over ${where}${v ? ` (${v.trim()})` : ""}, outside the version range the app declares`);
      }
    }
  }
  // A dependency no copy satisfies is staged anyway: that is the only copy
  // there is. But 0.3.0 will refuse to open the app, and the reason belongs
  // next to the line that staged it.
  for (const spec of plan.app.manifest.dependencySpecs ?? []) {
    if (!spec.version) continue;
    const chosen = plan.decisions.find((d) => d.name === spec.name)?.chosen;
    if (!chosen || satisfiesRange(chosen.manifest.version, spec.version) !== false) continue;
    out.push(
      `${spec.name}: ${chosen.manifest.version ?? "this copy"} is outside the range ${spec.version} the app declares, ` +
        `so Basecamp 0.3.0 will refuse to open the app`,
    );
  }
  return out;
}

/** stagingNotes, grouped by app name, for the `note` of each staged record. */
function notesFor(plan: StagingPlan): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of stagingNotes(plan)) {
    const name = n.slice(0, n.indexOf(":"));
    out.set(name, out.has(name) ? `${out.get(name)}; ${n.slice(name.length + 2)}` : n.slice(name.length + 2));
  }
  return out;
}

function sameArtifact(a: DiscoveredApp, b: DiscoveredApp): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a.artifact) === real(b.artifact);
}

/**
 * What a caller needs to unlock the wallet after the app opens, or null.
 *
 * Null when no password was given, when the app has no wallet provider, or
 * when that provider has no unlock verb — the standard Logos wallet has no
 * password at all, so asking for one there is meaningless.
 */
function unlockPlan(
  app: DiscoveredApp,
  staged: DiscoveredApp[],
  password: string | undefined,
): { provider: WalletProvider; password: string } | null {
  if (!password) return null;
  const provider = detectWalletProvider(app, staged);
  if (!provider || !provider.needsPassword) return null;
  return { provider, password };
}

function describeWallet(app: DiscoveredApp, staged: DiscoveredApp[], realHome: boolean): string | null {
  const provider = detectWalletProvider(app, staged);
  if (!provider) return null;
  return realHome
    ? `your real ${provider.name} wallet (${short(provider.storePath)})`
    : `a fresh throwaway ${provider.name} wallet`;
}

/** Trim a path for a one-line status without losing which directory it is. */
function short(p: string): string {
  const home = process.env.HOME ?? "";
  const rel = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return rel.length <= 48 ? rel : "…" + rel.slice(-47);
}

export function appLabel(app: DiscoveredApp): string {
  return uiLabel(app.manifest);
}

/**
 * Warnings about how this run's Basecamp was configured, one line each, for
 * the run header. Today: what a caller's config.yaml (0.3.0) does to the log.
 */
export function bootNotes(b: Pick<Boot, "userDir">): string[] {
  const logging = b.userDir?.loggingConfig;
  if (!logging) return [];
  const out: string[] = [];
  if (logging.problem) {
    out.push(`${logging.path} is not applied by Basecamp (${logging.problem}); it logs with its defaults`);
    return out;
  }
  if (!logging.enabled) {
    out.push(`${logging.path} sets logging.enabled: false, so Basecamp writes no log this run can read`);
  } else if (!logging.console) {
    out.push(
      `${logging.path} sets logging.console: false, so Basecamp mirrors nothing to stdout; ` +
        `reading ${path.join(logging.dir, logging.file)} instead`,
    );
  }
  if (logging.enabled && path.resolve(logging.dir) !== path.resolve(b.userDir!.root, "logs")) {
    out.push(`Basecamp's logs are in ${logging.dir}, as ${logging.path} says`);
  }
  return out;
}
