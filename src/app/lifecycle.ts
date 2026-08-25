// ---------------------------------------------------------------------------
// Owning the Basecamp process for the duration of a run.
//
// Launch, wait until the app is genuinely usable, hand out a log buffer and an
// inspector client, then take the whole process group down again.
//
// Two things make this less trivial than "spawn and wait for the port":
//
//   * The inspector port opens ~1.4 s in, well before modules have loaded, so
//     the port alone is a false ready signal. We additionally wait for the
//     "Logos Core started successfully" line and for the shell UI to answer a
//     probe through the inspector.
//   * Basecamp spawns a logos_host_qt child per core module. Killing only the
//     parent has historically left those behind, so we run the app in its own
//     process group and signal the group.
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { InspectorClient, sleep } from "../inspector/client.js";
import { LogBuffer } from "../logs/buffer.js";
import { parseLine } from "../logs/classify.js";
import { ChildStdoutSource, FileTailSource, type LogSource } from "../logs/source.js";
import { status } from "../report/status.js";
import type { DebugContext } from "../runner/debug.js";

export interface LaunchOptions {
  binary: string;
  userDir: string;
  /** Inspector port. Defaults to a free one so parallel runs don't collide. */
  port?: number;
  /** Run without a visible window. Default true. */
  headless?: boolean;
  /** Extra argv passed straight through to Basecamp. */
  args?: string[];
  env?: Record<string, string | undefined>;
  /** Point Basecamp's view entry points at a source tree (DEV_QML_PATH). */
  devQmlPath?: string;
  /**
   * Set QT_FORCE_STDERR_LOGGING=1 (default). Without it Qt logs to journald
   * and no call evidence is observable at all. Only turn it off to reproduce
   * how the app behaves under a normal desktop launch.
   */
  forceStderrLogging?: boolean;
  /**
   * How long SIGTERM is given before stop() escalates to SIGKILL. Default 10s.
   *
   * A parameter because the escalation path could otherwise only be exercised
   * by waiting out the full grace period — ten seconds to test one branch, in a
   * suite CONTRIBUTING says should take a few. A caller shutting down a batch
   * of runs has the same reason to want it shorter.
   */
  stopGraceMs?: number;
}

export interface ReadyOptions {
  timeoutMs?: number;
  /** Labels that must be present in the shell before we call it ready. */
  expectLabels?: string[];
}

export type SessionMode = "owned" | "attached";

export interface Session {
  readonly mode: SessionMode;
  readonly inspector: InspectorClient;
  readonly logs: LogBuffer;
  readonly logSource: LogSource;
  /** Null in attached mode. */
  readonly process: ChildProcess | null;
  readonly port: number;
  /** Debug context for interactive debugging */
  debug?: DebugContext;
  waitUntilReady(opts?: ReadyOptions): Promise<ReadySummary>;
  stop(): Promise<StopSummary>;
}

export interface ReadySummary {
  portMs: number;
  coreStartedMs: number | null;
  uiProbeMs: number | null;
  modulesLoaded: string[];
}

export interface StopSummary {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when SIGTERM was ignored and we had to escalate. */
  forced: boolean;
}

/**
 * Processes we started, so an interrupted run does not leave them behind.
 *
 * sitometres owns a Basecamp and, through it, a logos_host_qt per core module.
 * If the CLI dies before stop() runs — Ctrl-C, a CI timeout, a parent shell
 * going away — nothing else will ever reap them, and they sit holding a
 * user-dir and an inspector port. Observed: orphans left behind after a batch
 * run was interrupted.
 *
 * The child is spawned detached, so it leads its own process group and a
 * negative-pid signal takes the module hosts with it.
 */
const owned = new Set<number>();
/** Throwaway directories this process created, removed on the same signals. */
const ownedDirs = new Set<string>();
/**
 * Work that must happen even if the run is killed.
 *
 * Staging into a caller's real `--user-dir` moves their installed copy aside
 * and puts a build in its place. If the process dies before it can swap them
 * back, the developer is left without a plugin they had installed — a worse
 * outcome than the run failing. So the restore rides the same Ctrl-C, SIGTERM
 * and exit path that reaps the processes and the temp directories.
 */
const ownedRestores = new Set<() => void>();
let shutdownInstalled = false;

/**
 * Register a directory to remove if the run is interrupted.
 *
 * Reaping only the processes left the throwaway user-dir and $HOME behind —
 * a few MB per interrupted run, plus stale state that a later --user-dir run
 * would pick up.
 */
export function reapDirOnExit(dir: string): void {
  ownedDirs.add(dir);
  installShutdown();
}

/** Stop tracking a directory that has already been cleaned up normally. */
export function releaseDir(dir: string): void {
  ownedDirs.delete(dir);
}

/**
 * Register work to run if this process is interrupted. Returns a handle that
 * un-registers it once it has been done the normal way.
 */
export function restoreOnExit(fn: () => void): () => void {
  ownedRestores.add(fn);
  installShutdown();
  return () => ownedRestores.delete(fn);
}

/**
 * The tool's own environment, minus anything only the tool should see.
 *
 * `SITOMETRES_WALLET_PASSWORD` is the one that matters: `--help` tells users to
 * prefer the variable over the flag because a flag is visible to `ps` — and
 * then the whole environment, variable included, was handed to the app under
 * test and to everything it shells out to. sitometres exists to crawl OTHER
 * people's Basecamp modules, including ones unpacked from a `.lgx`, so that is
 * a credential handed to untrusted code.
 *
 * An explicit `--env SITOMETRES_X=y` still wins: `opts.env` is applied after
 * this, and passing one deliberately is the user's decision to make.
 */
export function sanitiseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("SITOMETRES_")) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Kill every process group this run started, and remove its throwaway dirs.
 *
 * Exported for tests. It is reachable in production only from signal handlers
 * and `process.on("exit")`, and `reapOnExit` — its only source of pids — was
 * called from exactly one place inside `launch()`, so the whole path could only
 * be exercised by launching a real Basecamp. That put the highest-consequence
 * failure this tool has (an orphaned Basecamp holding a user-dir, an unlocked
 * wallet and an open inspector port) behind the four tests that skip by default
 * and have no CI job.
 */
export function killOwned(): void {
  // Restores first: a half-finished run that leaves the developer's Basecamp
  // short of a plugin is the one outcome worth ordering the teardown around.
  for (const restore of ownedRestores) {
    try {
      restore();
    } catch {
      /* a failed restore must not stop the rest of the teardown */
    }
  }
  ownedRestores.clear();
  for (const pid of owned) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  owned.clear();
  for (const dir of ownedDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not worth failing an exit over */
    }
  }
  ownedDirs.clear();
}

/** Track a process group for reaping. Exported so killOwned can be tested. */
export function reapOnExit(pid: number): void {
  owned.add(pid);
  installShutdown();
}

function installShutdown(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      killOwned();
      // Re-raise with the default disposition so the exit status stays honest.
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
  process.on("exit", killOwned);
}

export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred) return preferred;
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

export async function launch(opts: LaunchOptions): Promise<Session> {
  const port = await findFreePort(opts.port);
  const headless = opts.headless !== false;

  const args = ["--user-dir", opts.userDir, ...(opts.args ?? [])];
  if (headless) args.push("-platform", "offscreen");

  const env: NodeJS.ProcessEnv = {
    ...sanitiseEnv(process.env),
    ...opts.env,
    QML_INSPECTOR_PORT: String(port),
    LOGOS_USER_DIR: opts.userDir,
  };
  if (headless) env.QT_QPA_PLATFORM = "offscreen";
  if (opts.devQmlPath) env.DEV_QML_PATH = opts.devQmlPath;
  // THE load-bearing variable. Qt is built with journald support, so by default
  // qDebug/qInfo/qWarning go to the systemd journal and never reach stderr —
  // which means Basecamp's LogRedirector never sees them and the whole call
  // trail is invisible. Measured on logos-basecamp 0.2.2: 5 lines captured
  // without it, 242 with it (22 of them LogosAPIClient call lines).
  // logos-qt-mcp's own test harness sets this for the same reason.
  if (opts.forceStderrLogging !== false) env.QT_FORCE_STDERR_LOGGING = "1";

  const child = spawn(opts.binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    // Own process group: lets stop() signal the module hosts too.
    detached: true,
  });

  const logs = new LogBuffer();

  // Without this, a binary that cannot be executed raises an unhandled 'error'
  // event and Node prints the one stack trace this tool otherwise never shows.
  let spawnFailure: Error | null = null;
  child.once("error", (err) => {
    spawnFailure = err;
    logs.close(`could not start ${opts.binary}: ${err.message}`);
  });

  if (child.pid !== undefined) reapOnExit(child.pid);
  const source = new ChildStdoutSource(logs, { stdout: child.stdout, stderr: child.stderr });
  const inspector = new InspectorClient({ port });

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
    if (child.pid !== undefined) owned.delete(child.pid);
    logs.close(`Basecamp exited (${signal ?? `code ${code}`})`);
  });

  return {
    mode: "owned",
    inspector,
    logs,
    logSource: source,
    process: child,
    port,
    debug: undefined, // Will be set by session.ts after creation

    async waitUntilReady(readyOpts: ReadyOptions = {}): Promise<ReadySummary> {
      const timeoutMs = readyOpts.timeoutMs ?? 120_000;
      const t0 = Date.now();

      if (spawnFailure) throw spawnFailure;
      status.set("Preparing", `waiting for the QML inspector on port ${port}`);
      const portPromise = inspector.waitUntilListening({ timeoutMs });
      // Racing against exit turns "the app died on startup" into a real error
      // with the log tail attached, instead of a bare connect timeout.
      await Promise.race([
        portPromise,
        (async () => {
          while (!exited) {
            if (spawnFailure) throw spawnFailure;
            await sleep(100);
          }
          throw new Error(
            `Basecamp exited during startup (${describeExit(exited)}).\n` +
              lastLines(logs, 25),
          );
        })(),
      ]);
      const portMs = Date.now() - t0;

      let coreStartedMs: number | null = null;
      status.set("Preparing", "waiting for Logos Core to start");
      try {
        const line = await logs.waitFor((l) => parseLine(l).signal?.kind === "core_started", {
          timeoutMs: Math.max(1000, timeoutMs - (Date.now() - t0)),
        });
        coreStartedMs = line.atMs;
      } catch {
        // Some builds do not emit it; the UI probe below is the real gate.
      }

      let uiProbeMs: number | null = null;
      const labels = readyOpts.expectLabels ?? ["Settings"];
      status.set("Preparing", "waiting for the Basecamp shell to render");
      const deadline = t0 + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const inventory = await inspector.textInventory();
          if (labels.every((want) => inventory.some((e) => e.text.includes(want)))) {
            uiProbeMs = Date.now() - t0;
            break;
          }
        } catch {
          /* the app may still be constructing its window */
        }
        await sleep(250);
      }

      const modulesLoaded = logs
        .slice(0)
        .map(parseLine)
        .filter((p) => p.signal?.kind === "module_loaded")
        .map((p) => p.signal!.target!)
        .filter((v, i, a) => a.indexOf(v) === i);

      if (uiProbeMs === null) {
        throw new Error(
          `Basecamp's shell never rendered ${JSON.stringify(labels)} within ${timeoutMs}ms.\n` +
            lastLines(logs, 25),
        );
      }
      return { portMs, coreStartedMs, uiProbeMs, modulesLoaded };
    },

    async stop(): Promise<StopSummary> {
      status.set(status ? "Running" : "Running", "shutting Basecamp down");
      inspector.disconnect();
      source.stop();
      if (exited) return { ...exited, forced: false };
      if (child.pid === undefined) return { code: null, signal: null, forced: false };

      signalGroup(child.pid, "SIGTERM");
      const clean = await waitForExit(child, opts.stopGraceMs ?? 10_000);
      if (clean) {
        logs.close("stopped");
        return { ...clean, forced: false };
      }
      signalGroup(child.pid, "SIGKILL");
      const forcedExit = await waitForExit(child, Math.max(1_000, (opts.stopGraceMs ?? 10_000) / 2));
      logs.close("killed");
      return { code: forcedExit?.code ?? null, signal: forcedExit?.signal ?? "SIGKILL", forced: true };
    },
  };
}

/**
 * Attach to a Basecamp already running under the developer's own hands.
 *
 * Log fidelity is materially worse here: we cannot see the process's stdout,
 * so we tail the on-disk files, which Basecamp writes through a buffered QFile
 * and only flushes on rotation or exit. Callers must treat log-based verdicts
 * from an attached session as INCONCLUSIVE rather than PASS.
 */
export function attach(opts: { port?: number; logsDir?: string }): Session {
  const port = opts.port ?? Number(process.env.QML_INSPECTOR_PORT ?? 3768);
  const inspector = new InspectorClient({ port });
  const logs = new LogBuffer();
  const source: LogSource = opts.logsDir
    ? new FileTailSource(opts.logsDir, logs)
    : { kind: "file-tail", lagging: true, describe: () => "no log source (pass --logs-dir)", stop: () => {} };

  return {
    mode: "attached",
    inspector,
    logs,
    logSource: source,
    process: null,
    port,
    debug: undefined, // Will be set by session.ts after creation
    async waitUntilReady(readyOpts: ReadyOptions = {}): Promise<ReadySummary> {
      const timeoutMs = readyOpts.timeoutMs ?? 30_000;
      const t0 = Date.now();
      await inspector.waitUntilListening({ timeoutMs });
      return { portMs: Date.now() - t0, coreStartedMs: null, uiProbeMs: null, modulesLoaded: [] };
    },
    async stop(): Promise<StopSummary> {
      // Never kill an app we did not start.
      inspector.disconnect();
      source.stop();
      logs.close("detached");
      return { code: null, signal: null, forced: false };
    },
  };
}

// --- helpers ---------------------------------------------------------------

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    // Negative pid = the whole process group, so logos_host_qt children go too.
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

function waitForExit(
  child: ChildProcess,
  ms: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve({ code: child.exitCode, signal: child.signalCode });
    }
    const timer = setTimeout(() => resolve(null), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function describeExit(e: { code: number | null; signal: NodeJS.Signals | null }): string {
  return e.signal ? `signal ${e.signal}` : `exit code ${e.code}`;
}

function lastLines(logs: LogBuffer, n: number): string {
  const tail = logs.tail(n);
  if (tail.length === 0) return "  (no output captured)";
  return tail.map((l) => `  | ${l.text}`).join("\n");
}
