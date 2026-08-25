// ---------------------------------------------------------------------------
// `sitometres run <spec.yaml>` — execute a written spec.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { uiLabel } from "../app/manifest.js";
import { toJson, toJUnit, type MachineReport } from "../report/machine.js";
import { printHeader, printStep, printSummary } from "../report/terminal.js";
import { Runner, type RunResult, type StepResult } from "../runner/runner.js";
import { resolveSetupSpec, runSetupProfile } from "../runner/setup.js";
import { type Spec, SpecError, validateSpec } from "../spec/schema.js";
import { boot, type BootOptions, type CommandDeps, REAL_DEPS } from "../session.js";
import { VERSION } from "../version.js";
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
    if (opts.json) writeOut(opts.json, toJson(report));
    if (opts.junit) writeOut(opts.junit, toJUnit(report));
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

  let b: Awaited<ReturnType<typeof boot>>;
  try {
    b = await deps.boot(bootOpts);
  } catch (err) {
    stillborn((err as Error).message);
    throw err;
  }
  try {
    const appName = b.app?.manifest.name ?? spec.app ?? null;
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
      ...(b.app ? { source: { origin: b.app.origin, form: b.app.form, builtAt: b.app.builtAt, ...(b.app.manifest.version ? { version: b.app.manifest.version } : {}) } } : {}),
    });

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
      userDirRoot?: string;
      openTimeoutMs?: number;
      onOpened?: () => Promise<{ failed: string | null }>;
    } = {
      session: b.session,
      spec,
      appName,
      logsUsable: b.fidelity.fidelity === "verbose",
      onStep: printStep,
      continueExecution: false,
      artifactDir: opts.artifactDir,
      walletUnlock: b.walletUnlock ?? undefined,
      manifest: b.app?.manifest,
      ...(b.app ? { app: b.app } : {}),
      ...(b.userDir ? { userDirRoot: b.userDir.root } : {}),
      openTimeoutMs: bootOpts.timeoutMs,
      ...(appName
        ? {
            onOpened: async () => {
              const resolved = resolveSetupSpec(opts, appName, b.app?.artifact ?? null);
              const outcome = await runSetupProfile(b, resolved, appName, "spec");
              return { failed: outcome.failed };
            },
          }
        : {}),
    };
    const runner = new Runner(runnerOpts);

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
        sandboxHome: b.sandboxHome,
        fidelity: b.fidelity,
        verdict,
        durationMs: result?.durationMs ?? Date.now() - startedAt,
        steps,
      };
      if (result) printSummary(result);
      else printSummary({ steps, verdict, durationMs: report.durationMs });
      if (opts.json) writeOut(opts.json, toJson(report));
      if (opts.junit) writeOut(opts.junit, toJUnit(report));
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
