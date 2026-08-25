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
import { type BasecampBinary, compareVersions, type DiscoveredApp, discoverApps, locateBasecamp, staleRememberedBasecamp } from "./app/discover.js";
import { attach, launch, reapDirOnExit, releaseDir, type ReadySummary, type Session } from "./app/lifecycle.js";
import { uiLabel } from "./app/manifest.js";
import { stageUserDir, type StagedUserDir } from "./app/userdir.js";
import { assessFidelity, type FidelityReport } from "./runner/fidelity.js";
import { status } from "./report/status.js";
import { detectWalletProvider, type WalletProvider } from "./app/wallet.js";
import { configPath, saveConfig } from "./config.js";
import { ask, canPrompt } from "./report/prompt.js";
import type { DebugContext } from "./runner/debug.js";

export interface BootOptions {
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
  /** The throwaway $HOME given to the app, or null when the real one is in use. */
  sandboxHome: string | null;
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
    const session = attach(opts.attachTo);
    const ready = await session.waitUntilReady({ timeoutMs: opts.timeoutMs ?? 30_000 });
    
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
      // Attached sessions read buffered log FILES, which Basecamp flushes only
      // on rotation or exit, so we never claim the log is authoritative here.
      fidelity: {
        fidelity: "quiet",
        qtLogLines: 0,
        moduleLogLines: 0,
        summary: "Attached to a running Basecamp; its live stdout is not available to us.",
        remedy:
          "Log-based assertions read the on-disk log, which Basecamp buffers and flushes only on rotation " +
          "or exit, so they are reported INCONCLUSIVE. Let sitometres launch the app to get live evidence.",
      },
      app: null,
      staged: [],
      basecamp: null,
      userDir: null,
      sandboxHome: null,
      walletSummary: null,
      // Attach mode drives someone else's process; sitometres neither chose
      // its wallet nor can unlock one on its behalf.
      walletUnlock: null,
      debug: debugContext,
      async dispose() {
        await session.stop();
      },
    };
  }

  // --- owned mode ----------------------------------------------------------
  // Look in the working directory first, then in the developer's Basecamp
  // install, so `sitometres <app>` works from anywhere without a --app-dir.
  status.set("Preparing", `looking for an app in ${short(cwd)}`);
  let candidates = discoverApps(cwd);
  if (opts.app && !candidates.some((c) => c.manifest.name === opts.app)) {
    // Widen to the Basecamp install, keeping the local copy of any name that
    // exists in both — a developer testing from their repo means their build.
    status.set("Preparing", `"${opts.app}" is not here — checking your Basecamp install`);
    const byName = new Map(candidates.map((c) => [c.manifest.name, c]));
    for (const inst of installedApps()) {
      const prev = byName.get(inst.manifest.name);
      if (!prev || (prev.incomplete && !inst.incomplete)) byName.set(inst.manifest.name, inst);
    }
    candidates = [...byName.values()];
  }
  const app = selectApp(candidates, opts.app);

  if (app.incomplete) {
    throw new BootError(`"${app.manifest.name}" is not built`, `${app.incomplete}. Build it first, then run sitometres again.`);
  }

  const wanted = new Set<string>([app.manifest.name, ...app.manifest.dependencies, ...(opts.with ?? [])]);
  const staged = collectWithDependencies(candidates, wanted, cwd, app.manifest.name);

  status.set("Preparing", `resolving ${app.manifest.name} and ${app.manifest.dependencies.length} dependency(ies)`);
  const stubs = staged.filter((s) => s.incomplete);
  if (stubs.length > 0) {
    const s0 = stubs[0]!;
    throw new BootError(
      `"${app.manifest.name}" needs "${s0.manifest.name}", and the only copy found is not built`,
      `${s0.incomplete}. Build that module, or point sitometres at a built copy — ` +
        `if it is already installed in Basecamp, sitometres will find it there automatically.`,
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

  // --real-home is the ONE lever that decides this. A wallet password used to
  // be folded in here, which meant passing one silently handed the app the
  // developer's real $HOME — the opposite of what its help text promised.
  const useRealHome = opts.realHome === true;
  if (!useRealHome) status.set("Preparing", "creating a throwaway HOME so app data stays private to this run");
  const sandbox = useRealHome ? null : makeSandboxHome();
  const launchOpts: Parameters<typeof launch>[0] = {
    binary: basecamp.path,
    userDir: userDir.root,
    headless: opts.headless !== false,
    env: { ...(sandbox?.env ?? {}), ...(opts.env ?? {}) },
  };
  if (opts.port !== undefined) launchOpts.port = opts.port;
  status.set("Preparing", `launching Basecamp${opts.headless === false ? "" : " (offscreen)"}`);
  const session = await launch(launchOpts);

  let ready: ReadySummary;
  try {
    ready = await session.waitUntilReady({ timeoutMs: opts.timeoutMs ?? 120_000 });
  } catch (err) {
    await session.stop();
    userDir.cleanup();
    sandbox?.cleanup();
    throw err;
  }

  status.set("Preparing", "checking what this build's logs will show");
  const fidelity = assessFidelity(session.logs);

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
    basecamp,
    userDir,
    sandboxHome: sandbox?.root ?? null,
    walletSummary: describeWallet(app, staged, useRealHome),
    walletUnlock: unlockPlan(app, staged, opts.wallet?.password),
    debug: debugContext,
    async dispose() {
      await session.stop();
      userDir.cleanup();
      sandbox?.cleanup();
    },
  };
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
 * Resolve the app plus everything it declares a dependency on.
 *
 * A dependency built in a sibling directory is common (a UI plugin in one repo,
 * its core module in another), so we widen the search to the parent directory
 * before giving up — but only for names actually declared.
 */
/** Apps already installed into a Basecamp on this machine. */
/**
 * Every place a Basecamp install could be, on this platform.
 *
 * One implementation, because there were three and they disagreed: only this
 * one knew the macOS locations, so dependency staging and `doctor` were
 * Linux-only. A macOS author got a hard error reading "Looked in this repo,
 * its parent, and your Basecamp install" — which was false, it had not — and a
 * doctor that said an installed dependency was not there.
 *
 * $LOGOS_USER_DIR wins when set; it is Basecamp's own override.
 */
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

/**
 * Where Basecamp keeps its user-dir on this platform.
 *
 * The platform and home are parameters so both branches can be asserted from
 * either host. Reading `process.platform` directly, the darwin branch was
 * executed by nothing at all: CI runs ubuntu only, and the one test covering
 * it asserted the Linux list when it was not on a Mac — so it would have passed
 * with the darwin code deleted, while an archived task recorded the coverage
 * as done.
 */
export function basecampUserDirs(
  platform: string = process.platform,
  home: string = process.env.HOME ?? os.homedir(),
): string[] {
  const perPlatform =
    platform === "darwin"
      ? ["Library/Application Support/Logos/LogosBasecampDev", "Library/Application Support/Logos/LogosBasecamp"]
      : [".local/share/Logos/LogosBasecampDev", ".local/share/Logos/LogosBasecamp"];
  return [
    process.env.LOGOS_USER_DIR,
    ...perPlatform.map((rel) => path.join(home, rel)),
    // Kept for a developer who moved between platforms, or a shared checkout.
    ...(platform === "darwin"
      ? [".local/share/Logos/LogosBasecampDev", ".local/share/Logos/LogosBasecamp"].map((r) => path.join(home, r))
      : []),
  ].filter((d): d is string => Boolean(d));
}

export function installedApps(): DiscoveredApp[] {
  const out: DiscoveredApp[] = [];
  for (const d of basecampUserDirs()) {
    if (!fs.existsSync(d)) continue;
    out.push(...discoverApps(d));
  }
  return out;
}

function collectWithDependencies(
  candidates: DiscoveredApp[],
  wanted: Set<string>,
  cwd: string,
  /**
   * The app under test, which the sweep below must never replace.
   *
   * `selectApp` has already chosen it out of what was found where the user
   * pointed, and "a developer testing from their repo means their build" — the
   * rule the widening path above states explicitly. The dependency sweep did not
   * honour it: it searches `path.dirname(cwd)`, and `discoverApps` scans one
   * level of children below its root, so it reaches every SIBLING project. A
   * sibling holding a plugin of the same name — a fork, a second checkout, a
   * copy — would win on `builtAt` alone and be staged in place of the build the
   * user asked for, reported only as a different `built` line in the header.
   */
  appUnderTest: string,
): DiscoveredApp[] {
  const byName = new Map<string, DiscoveredApp>();
  for (const c of candidates) {
    const prev = byName.get(c.manifest.name);
    // A built copy beats a stub; between two builds, the newer one wins.
    if (!prev || (prev.incomplete && !c.incomplete) || (!c.incomplete && c.builtAt > prev.builtAt)) {
      byName.set(c.manifest.name, c);
    }
  }

  // Always consider the Basecamp install as a candidate, not only when the
  // local copy is missing. A complete-but-OLD artifact in dist/ would otherwise
  // beat a newer installed module purely by being found first.
  {
    // A developer's Basecamp install is the most likely place a dependency is
    // already sitting; look there before the filesystem at large.
    const installed = [...basecampUserDirs(), path.dirname(cwd)];
    for (const dir of installed) {
      for (const found of discoverApps(dir)) {
        if (!wanted.has(found.manifest.name) || found.incomplete) continue;
        // Dependencies are worth hunting for; the app under test is not.
        if (found.manifest.name === appUnderTest) continue;
        const prev = byName.get(found.manifest.name);
        if (!prev || prev.incomplete) {
          byName.set(found.manifest.name, found);
          continue;
        }
        const byVersion = compareVersions(found.manifest.version, prev.manifest.version);
        if (byVersion > 0 || (byVersion === 0 && found.builtAt > prev.builtAt)) {
          byName.set(found.manifest.name, found);
        }
      }
    }
  }

  return [...wanted].map((n) => byName.get(n)).filter((c): c is DiscoveredApp => c !== undefined);
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
