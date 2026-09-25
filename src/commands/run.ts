// ---------------------------------------------------------------------------
// `sitometres run <spec.yaml>` — execute a written spec.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { uiLabel } from "../app/manifest.js";
import { buildSourceOf, toJson, toJUnit, type MachineReport } from "../report/machine.js";
import { printHeader, printStep, printSummary } from "../report/terminal.js";
import { type OpenedScope, Runner, type RunResult, type StagedAppRef, type StepResult } from "../runner/runner.js";
import { resolveNamedSetupSpec, resolveSetupSpec, runSetupProfile, type SetupHost } from "../runner/setup.js";
import { parseDuration, type Spec, SpecError, validateSpec } from "../spec/schema.js";
import { boot, type BootOptions, bootNotes, type CommandDeps, REAL_DEPS, stagingNotes } from "../session.js";
import { VERSION } from "../version.js";
import { openBudgetFrom } from "../timeouts.js";
import type { WalletProvider } from "../app/wallet.js";
import type { AppManifest } from "../app/manifest.js";
import type { Session } from "../app/lifecycle.js";

export interface RunOptions extends BootOptions {
  specPath: string;
  json?: string;
  junit?: string;
  artifactDir?: string;
  debug?: boolean;
  /** Make an INCONCLUSIVE run fail, for a CI gate. */
  strict?: boolean;
  breakpoint?: number;
  /**
   * A setup profile to run once the spec has opened the app.
   *
   * Discovered the same way the crawl discovers one. Without it, a spec for a
   * gated app had to inline and maintain its own copy of the gate walkthrough:
   * `examples/medusa_wallet.yaml` duplicates `profiles/medusa_ui.yaml` today,
   * with nothing checking they stay in step.
   */
  setup?: string;
  noSetup?: boolean;
  /**
   * --settle: how long a step watches before accepting a clean negative
   * expectation, when neither the step nor the spec says.
   */
  settleMs?: number;
}

export function loadSpec(specPath: string): Spec {
  const text = fs.readFileSync(specPath, "utf8");
  let doc: unknown;
  try {
    doc = specPath.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
  } catch (err) {
    throw new SpecError(`could not parse: ${(err as Error).message}`, specPath);
  }
  return validateSpec(doc);
}

export async function run(opts: RunOptions, deps: CommandDeps = REAL_DEPS): Promise<number> {
  const t0 = Date.now();
  /**
   * Write a one-step failing report for a run that never got going.
   *
   * `smoke` was hardened for this and `run` was not — yet `run` is the verb the
   * README's CI section documents. A bad spec path, a missing Basecamp or a
   * failed staging exited 1 having written neither `--junit` nor `--json`,
   * which every publisher reports as "no test results".
   */
  /**
   * Both artifacts, written independently, and never allowed to throw.
   *
   * These used to be two bare calls, --json then --junit. A throw in the second
   * escaped to the catch at the foot of this function, which called stillborn()
   * - and stillborn OVERWROTE the --json that had just been written correctly
   * with a one-step "the run did not start" failure. A run that passed was
   * published as a run that never began, which is the worst thing this output
   * can say. Whatever breaks one writer, the caller is still owed the other and
   * the verdict the run actually reached.
   */
  const emitBoth = (report: MachineReport): void => {
    if (opts.json) {
      try {
        writeOut(opts.json, toJson(report));
      } catch (err) {
        console.error(`  --json could not be written: ${(err as Error).message}`);
      }
    }
    if (opts.junit) {
      try {
        writeOut(opts.junit, toJUnit(report));
      } catch (err) {
        console.error(`  --junit could not be written: ${(err as Error).message}`);
      }
    }
  };

  const stillborn = (why: string): void => {
    const report: MachineReport = {
      tool: "sitometres",
      version: VERSION,
      app: opts.specPath,
      basecamp: "(not started)",
      fidelity: { fidelity: "quiet", qtLogLines: 0, moduleLogLines: 0, summary: "the run did not start", remedy: "" },
      verdict: "fail",
      durationMs: Date.now() - t0,
      steps: [{
        index: 0,
        name: "start the run",
        action: "start",
        verdict: "fail",
        durationMs: Date.now() - t0,
        checks: [{ kind: "state", description: "the run started", verdict: "fail", detail: why }],
        callsObserved: [],
      }],
    };
    emitBoth(report);
  };

  let spec: Spec;
  try {
    spec = loadSpec(opts.specPath);
  } catch (err) {
    stillborn((err as Error).message);
    throw err;
  }

  // Spec fields are defaults; explicit CLI flags win.
  const bootOpts: BootOptions = { ...opts };
  if (bootOpts.app === undefined && spec.app) bootOpts.app = spec.app;
  if (bootOpts.basecamp === undefined && spec.basecamp) bootOpts.basecamp = spec.basecamp;
  if (bootOpts.headless === undefined && spec.headless !== undefined) bootOpts.headless = spec.headless;
  if (bootOpts.with === undefined && spec.with) bootOpts.with = spec.with;
  // Startup describes the machine, not the app, so it follows the same rule:
  // --timeout wins over the spec's startup_timeout.
  if (bootOpts.timeoutMs === undefined && spec.startupTimeout !== undefined) {
    bootOpts.timeoutMs = parseDuration(spec.startupTimeout, 0);
  }
  // Commands issued outside any step (the readiness probe, a profile's own
  // open) take --command-timeout, else the spec's. The bridge window is the
  // other way round, like every step-level knob: the spec that declares it
  // knows the build it was written for.
  if (bootOpts.commandTimeoutMs === undefined && spec.commandTimeout !== undefined) {
    bootOpts.commandTimeoutMs = parseDuration(spec.commandTimeout, 0);
  }
  if (spec.callTimeout !== undefined) bootOpts.callTimeoutMs = parseDuration(spec.callTimeout, 0);

  let b: Awaited<ReturnType<typeof boot>>;
  try {
    b = await deps.boot(bootOpts);
  } catch (err) {
    stillborn((err as Error).message);
    throw err;
  }
  try {
    const appName = b.app?.manifest.name ?? spec.app ?? null;
    // Computed once and spent twice. The header and the machine artifact have to
    // name the same build; two independently-built descriptions of it is how
    // they come to disagree.
    const source = buildSourceOf(b.app);
    // Every staged artifact and its hash, once, for the header and both
    // machine artifacts alike. Absent from a stub boot that predates them.
    const stagedRecords = b.stagedRecords ?? [];
    const notes = b.plan ? stagingNotes(b.plan) : [];
    printHeader({
      app: b.app ? uiLabel(b.app.manifest) : (appName ?? "(attached)"),
      appType: b.app?.manifest.type ?? "unknown",
      dependencies: b.app?.manifest.dependencies ?? [],
      basecamp: b.basecamp?.path ?? "(attached)",
      userDir: b.userDir?.root ?? "(attached)",
      sandboxHome: b.sandboxHome,
      attached: b.basecamp === null,
      ...(b.userDir?.foreign.length ? { foreignApps: b.userDir.foreign } : {}),
      ...(b.userDir?.replaced.length ? { replacedApps: b.userDir.replaced } : {}),
      ...(b.userDir?.restores ? { restoresUserDir: true } : {}),
      ...(b.userDir?.inPlace.length ? { inPlaceApps: b.userDir.inPlace } : {}),
      ...(b.walletUnlock ? { walletUnlocked: true } : {}),
      logSource: b.session.logSource.describe(),
      fidelity: b.fidelity,
      headless: bootOpts.headless !== false,
      inspectorPort: b.session.port,
      ...(b.walletSummary ? { wallet: b.walletSummary } : {}),
      ...(source ? { source } : {}),
      staged: stagedRecords,
      stagingNotes: notes,
      ...(b.session.launchEnv ? { launchEnv: b.session.launchEnv } : {}),
      notes: bootNotes(b),
    });

    // Which profile belongs to which app, each run once, after that app's
    // first open. The spec app's is found the usual way and honours --setup; a
    // `with:` app's only under its own name, so the directory's unnamed
    // profile never lands on the wallet a dApp spec happens to open.
    //
    // Once a second app's dock exists, the profile starts inside the dock of
    // the app it belongs to. Unscoped, its selectors and `state:` reached the
    // whole window and the first QQuickWidget's root, so a wallet profile's
    // positional `{ type: ..., nth: 0 }` could type into the dApp. With one
    // dock there is nowhere else to land, and a single-app run is left exactly
    // as it was.
    const profiled = new Set<string>();
    const docks = new Set<string>();
    // A profile inherits the run's budgets the way the spec does, below its
    // own header and steps. The spec's startup_timeout reached boot through
    // the same field as --timeout, and is not a budget for anything a profile
    // opens, so only the flag is passed on.
    const { timeoutMs: _startup, ...inherited } = b.timeouts ?? {};
    const host: SetupHost = {
      session: b.session,
      app: b.app,
      userDir: b.userDir,
      appHome: b.appHome,
      fidelity: b.fidelity,
      timeouts: { ...inherited, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
      ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}),
    };
    const setupFor = async (moduleName: string, scope?: OpenedScope): Promise<{ failed: string | null }> => {
      docks.add(moduleName);
      if (profiled.has(moduleName)) return { failed: null };
      profiled.add(moduleName);
      // Always hand the profile the scope of the app that was just opened. Without it a profile
      // had no QML root, so its `state:` read nothing; opening the app again from inside the
      // profile is worse, because Basecamp rebuilds an app whose launcher is clicked again and the
      // spec then found a fresh, locked UI. The profile's selectors stay inside this app's dock,
      // which with one dock is everything the app draws.
      const seed = scope ? { module: moduleName, scope } : undefined;
      if (moduleName === appName) {
        const resolved = resolveSetupSpec(opts, moduleName, b.app?.artifact ?? null);
        return { failed: (await runSetupProfile(host, resolved, moduleName, "spec", undefined, undefined, seed)).failed };
      }
      if (opts.noSetup) return { failed: null };
      const withApp = b.staged?.find((a) => a.manifest.name === moduleName);
      const resolved = resolveNamedSetupSpec(opts, moduleName, withApp?.artifact ?? null);
      return { failed: (await runSetupProfile(host, resolved, moduleName, "spec", undefined, withApp, seed)).failed };
    };

    // Decided from the spec, once the runner exists, so the terminal and the
    // JUnit agree from step 1 on whether each step names its app.
    let showApp = false;
    const open = openBudgetFrom(opts);
    const runnerOpts: {
      session: Session;
      spec: Spec;
      appName: string | null;
      logsUsable: boolean;
      onStep: (result: StepResult) => void;
      continueExecution: boolean;
      artifactDir?: string;
      walletUnlock?: { provider: WalletProvider; password: string } | undefined;
      manifest?: AppManifest;
      app?: { manifest: { view?: string }; slot: string };
      apps?: StagedAppRef[];
      userDirRoot?: string;
      appHome?: string | null;
      openTimeoutMs?: number;
      openTimeoutExplicit?: boolean;
      stepTimeoutMs?: number;
      commandTimeoutMs?: number;
      callTimeoutMs?: number;
      settleMs?: number;
      onOpened?: (moduleName: string, scope: OpenedScope) => Promise<{ failed: string | null }>;
    } = {
      session: b.session,
      spec,
      appName,
      logsUsable: b.fidelity.fidelity === "verbose",
      onStep: (r) => printStep(r, { showApp }),
      continueExecution: false,
      artifactDir: opts.artifactDir,
      walletUnlock: b.walletUnlock ?? undefined,
      manifest: b.app?.manifest,
      ...(b.app ? { app: b.app } : {}),
      // Every staged app, so `open:` and `in:` can name the wallet a dApp spec
      // stages with `with:`, and not only the spec's own app.
      ...(b.staged?.length ? { apps: b.staged } : {}),
      ...(b.userDir ? { userDirRoot: b.userDir.root } : {}),
      // Where `file:` looks. b.sandboxHome would have been wrong here: it is
      // null under --real-home too, and a spec's relative path has to keep
      // resolving against whatever $HOME the app was actually handed.
      appHome: b.appHome,
      // The command line's budgets, below the spec's own in precedence; the
      // runner resolves each step from the step, then the spec, then these.
      // --open-timeout is honoured as given; --timeout still reaches the open,
      // as it always has, but as a fallback with the open's floor.
      ...(open.timeoutMs !== undefined ? { openTimeoutMs: open.timeoutMs, openTimeoutExplicit: open.explicit } : {}),
      ...(opts.stepTimeoutMs !== undefined ? { stepTimeoutMs: opts.stepTimeoutMs } : {}),
      ...(opts.commandTimeoutMs !== undefined ? { commandTimeoutMs: opts.commandTimeoutMs } : {}),
      ...(opts.callTimeoutMs !== undefined ? { callTimeoutMs: opts.callTimeoutMs } : {}),
      ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}),
      ...(appName ? { onOpened: setupFor } : {}),
    };
    const runner = new Runner(runnerOpts);
    showApp = runner.multiApp;

    // Written from a finally, so a run that dies still reports what it learned.
    // Building the report from run()'s return value meant a click that killed
    // the app produced no summary, no --json and no --junit at all: CI reported
    // "no test results" rather than naming the step that crashed it.
    const startedAt = Date.now();
    let result: RunResult | null = null;
    try {
      result = await runner.run();
    } finally {
      const steps = result?.steps ?? runner.completed;
      const verdict = result?.verdict ?? (steps.length > 0 ? "fail" : "inconclusive");
      const report: MachineReport = {
        tool: "sitometres",
        version: VERSION,
        app: appName,
        basecamp: b.basecamp?.path ?? "(attached)",
        ...(source ? { source } : {}),
        sandboxHome: b.sandboxHome,
        fidelity: b.fidelity,
        verdict,
        durationMs: result?.durationMs ?? Date.now() - startedAt,
        steps,
        ...(stagedRecords.length ? { staged: stagedRecords } : {}),
        ...(runner.multiApp ? { multiApp: true } : {}),
      };
      if (result) printSummary(result);
      else printSummary({ steps, verdict, durationMs: report.durationMs });
      emitBoth(report);
    }

    // Inconclusive does not fail the build by default: the assertion could not
    // be checked, which is a property of the build under test, not of the app's
    // behaviour. --strict is for a CI gate, where a run that proved nothing
    // passing is worse than a run that fails — it reads as evidence when it is
    // the absence of evidence.
    if (result.verdict === "fail") return 1;
    if (opts.strict && result.verdict === "inconclusive") {
      console.log("  --strict: the run proved nothing, and that is being treated as a failure");
      return 1;
    }
    return 0;
  } catch (err) {
    // Anything escaping the body — the header, constructing the Runner — must
    // still leave the evidence the caller asked for.
    stillborn((err as Error).message);
    throw err;
  } finally {
    await b.dispose();
  }
}

function writeOut(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
}
