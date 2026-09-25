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
//     shell UI to answer a probe through the inspector. Basecamp prints
//     "Logos Core started successfully" before it creates that window, so the
//     line is recorded when it appears rather than waited for: some builds
//     never print it.
//   * Basecamp spawns a logos_host_qt child per core module, and a ui-host
//     per view module. Killing only the parent has historically left those
//     behind, so we run the app in its own process group and signal the
//     group. On both 0.2.2 and 0.3.0 the hosts call setsid() and so leave that
//     group; what reaps them on Linux is the PR_SET_PDEATHSIG each one sets,
//     which fires when Basecamp itself goes. The group signal is for anything
//     else Basecamp started.
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { InspectorClient, sleep } from "../inspector/client.js";
import { LogBuffer } from "../logs/buffer.js";
import { parseLine } from "../logs/classify.js";
import { ChildStdoutSource, FileTailSource, type LogSource, MergedSource } from "../logs/source.js";
import { status } from "../report/status.js";
import type { DebugContext } from "../runner/debug.js";
import { DEFAULT_ATTACH_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS, describeBudget } from "../timeouts.js";

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
  /**
   * The inspector's per-command deadline outside any spec step. A step scopes
   * its own over it. Default: the bridge's stock reply window plus a margin.
   */
  commandTimeoutMs?: number;
  /**
   * Also read the session's log file, for a Basecamp whose stdout mirror is
   * switched off (0.3.0's `logging.console: false` in a user-dir's
   * config.yaml). `file` is the configured name, "basecamp.log" by default.
   */
  tailLogs?: { dir: string; file?: string };
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
  /**
   * The logging switches Basecamp was launched with, for the run header. See
   * describeLaunchEnv. Absent in attached mode, which chose none of them.
   */
  readonly launchEnv?: Record<string, string>;
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
 * negative-pid signal reaches everything in it. The module hosts and ui-hosts
 * are not in it: they call setsid() (0.2.2 and 0.3.0 alike) and die through
 * PR_SET_PDEATHSIG when Basecamp does, which is why killing Basecamp is enough.
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
    if (NOT_INHERITED.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Variables in the developer's shell that change what Basecamp does, and so
 * would make a run on one machine disagree with the same run on another.
 *
 *   LOGOS_ACCESS_POLICY  0.3.0: "enforce" denies a ui_qml app's calls to its
 *                        own backend, and an invalid value aborts startup.
 *   LOGOS_MOCK_FIXTURE   0.3.0 mock builds answer from this fixture.
 *   QT_MESSAGE_PATTERN   both: every log pattern here, and the
 *                        `logos.viewhost: ` prefix, assume Qt's default.
 *
 * Each still reaches the app when it is passed with --env.
 */
const NOT_INHERITED = new Set(["LOGOS_ACCESS_POLICY", "LOGOS_MOCK_FIXTURE", "QT_MESSAGE_PATTERN"]);

/** The rule that lets 0.3.0's ui-host output reach the log. See buildLaunchEnv. */
export const VIEWHOST_RULE = "logos.viewhost.debug=true";

/**
 * The environment Basecamp is launched with.
 *
 * Built from the tool's own environment, minus what only the tool should see
 * (sanitiseEnv), then the caller's --env, then what the launch itself needs.
 * Three logging switches, each load-bearing:
 *
 *   QT_FORCE_STDERR_LOGGING=1  Qt is built with journald support, so by
 *     default qDebug/qInfo/qWarning go to the systemd journal and never reach
 *     stderr, which means Basecamp's log redirect never sees them and the
 *     whole call trail is invisible. Measured on logos-basecamp 0.2.2: 5 lines
 *     captured without it, 242 with it (22 of them LogosAPIClient call lines).
 *     logos-qt-mcp's own test harness sets this for the same reason.
 *   LOGOS_LOG_LEVEL=debug  0.3.0 routes a module host's qDebug to spdlog's
 *     debug level, and liblogos logs at info unless told otherwise, so without
 *     it no `emitEvent` line reaches the log. Left alone when the caller set
 *     LOGOS_LOG_LEVEL or SPDLOG_LEVEL. 0.2.2 hosts log that output at info
 *     already, and its liblogos has no debug line any pattern here reads.
 *   QT_LOGGING_RULES  0.3.0 forwards a view module's ui-host output under the
 *     logos.viewhost category, which is off by default; the rule turns it on.
 *     It goes FIRST, because Qt applies the last matching rule: a rule the
 *     caller wrote still wins. 0.2.2 has no such category.
 *
 * The module hosts and ui-hosts inherit all three, which is intended.
 * Exported so the environment can be tested without launching anything.
 */
export function buildLaunchEnv(
  processEnv: NodeJS.ProcessEnv,
  opts: Pick<LaunchOptions, "env" | "userDir" | "devQmlPath" | "forceStderrLogging"> & {
    port: number;
    headless: boolean;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...sanitiseEnv(processEnv),
    ...opts.env,
    QML_INSPECTOR_PORT: String(opts.port),
    LOGOS_USER_DIR: opts.userDir,
  };
  if (opts.headless) env.QT_QPA_PLATFORM = "offscreen";
  if (opts.devQmlPath) env.DEV_QML_PATH = opts.devQmlPath;
  if (opts.forceStderrLogging !== false) env.QT_FORCE_STDERR_LOGGING = "1";
  if (env.LOGOS_LOG_LEVEL === undefined && env.SPDLOG_LEVEL === undefined) env.LOGOS_LOG_LEVEL = "debug";
  env.QT_LOGGING_RULES = [VIEWHOST_RULE, env.QT_LOGGING_RULES].filter(Boolean).join(";");
  return env;
}

/**
 * The launch variables worth printing in a run header: the logging switches,
 * and a Basecamp access policy when one was passed.
 */
export function describeLaunchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["LOGOS_LOG_LEVEL", "SPDLOG_LEVEL", "QT_LOGGING_RULES", "LOGOS_ACCESS_POLICY"]) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
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

  const env = buildLaunchEnv(process.env, { ...opts, port, headless });

  const logs = new LogBuffer();
  // Opened before the spawn, so the file tail starts past every older
  // session's log and reads only the one this launch creates.
  const fileTail = opts.tailLogs
    ? new FileTailSource(opts.tailLogs.dir, logs, { ...(opts.tailLogs.file ? { file: opts.tailLogs.file } : {}) })
    : null;

  const child = spawn(opts.binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    // Own process group: lets stop() signal the module hosts too.
    detached: true,
  });

  // Without this, a binary that cannot be executed raises an unhandled 'error'
  // event and Node prints the one stack trace this tool otherwise never shows.
  let spawnFailure: Error | null = null;
  child.once("error", (err) => {
    spawnFailure = err;
    logs.close(`could not start ${opts.binary}: ${err.message}`);
  });

  if (child.pid !== undefined) reapOnExit(child.pid);
  const stdoutSource = new ChildStdoutSource(logs, { stdout: child.stdout, stderr: child.stderr });
  const source: LogSource = fileTail ? new MergedSource([stdoutSource, fileTail]) : stdoutSource;
  const inspector = new InspectorClient(
    opts.commandTimeoutMs !== undefined ? { port, timeoutMs: opts.commandTimeoutMs } : { port },
  );

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
    launchEnv: describeLaunchEnv(env),
    debug: undefined, // Will be set by session.ts after creation

    async waitUntilReady(readyOpts: ReadyOptions = {}): Promise<ReadySummary> {
      const timeoutMs = readyOpts.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
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

      // The UI probe is the gate, from the moment the port is up. "Logos Core
      // started successfully" is only recorded: some builds never print it,
      // and waiting for it first used to spend the whole startup budget on a
      // line that was not coming, leaving the probe no turn at all (and, with
      // no deadline, waiting forever on a shell that was already drawn).
      // Basecamp prints it before it creates the window, so on a build that
      // does print it, the shell cannot be drawn any sooner than before.
      const labels = readyOpts.expectLabels ?? ["Settings"];
      status.set("Preparing", "waiting for the Basecamp shell to render");
      const deadline = t0 + timeoutMs;
      let uiProbeMs: number | null = null;
      // Probed at least once, even when the port took the whole budget.
      for (let first = true; first || Date.now() < deadline; first = false) {
        if (spawnFailure) throw spawnFailure;
        if (exited) {
          throw new Error(`Basecamp exited during startup (${describeExit(exited)}).\n` + lastLines(logs, 25));
        }
        try {
          // Each probe is bounded by what is left of the startup budget as
          // well as by the command deadline, so a shell that hangs on one
          // probe cannot carry startup past its own budget. A probe made
          // with nothing left is bounded by the command deadline alone.
          const left = deadline - Date.now();
          const probeMs = left > 0 ? Math.min(inspector.commandTimeoutMs, left) : inspector.commandTimeoutMs;
          const inventory = await inspector.withCommandTimeout(probeMs, () => inspector.textInventory());
          if (labels.every((want) => inventory.some((e) => e.text.includes(want)))) {
            uiProbeMs = Date.now() - t0;
            break;
          }
        } catch {
          /* the app may still be constructing its window */
        }
        await sleep(250);
      }
      const coreLine = logs.slice(0).find((l) => parseLine(l).signal?.kind === "core_started");
      const coreStartedMs = coreLine ? coreLine.atMs : null;

      const modulesLoaded = logs
        .slice(0)
        .map(parseLine)
        .filter((p) => p.signal?.kind === "module_loaded")
        .map((p) => p.signal!.target!)
        .filter((v, i, a) => a.indexOf(v) === i);

      if (uiProbeMs === null) {
        throw new Error(
          `Basecamp's shell never rendered ${JSON.stringify(labels)} within ${describeBudget(timeoutMs)}.\n` +
            lastLines(logs, 25),
        );
      }
      return { portMs, coreStartedMs, uiProbeMs, modulesLoaded };
    },

    async stop(): Promise<StopSummary> {
      status.set(status ? "Running" : "Running", "shutting Basecamp down");
      inspector.disconnect();
      if (exited || child.pid === undefined) {
        source.stop();
        releasePipes(child);
        return exited ? { ...exited, forced: false } : { code: null, signal: null, forced: false };
      }

      // Signal first and read on until the process is gone: what Basecamp
      // prints while it shuts down (a QML error in a destructor, a call that
      // fails as its module goes) is evidence too, and stopping the source
      // first threw it away on both 0.2.2 and 0.3.0.
      signalGroup(child.pid, "SIGTERM");
      const clean = await waitForExit(child, opts.stopGraceMs ?? 10_000);
      if (clean) {
        await drainPipes(child, SHUTDOWN_DRAIN_MS);
        source.stop();
        releasePipes(child);
        logs.close("stopped");
        return { ...clean, forced: false };
      }
      signalGroup(child.pid, "SIGKILL");
      const forcedExit = await waitForExit(child, Math.max(1_000, (opts.stopGraceMs ?? 10_000) / 2));
      source.stop();
      releasePipes(child);
      logs.close("killed");
      return { code: forcedExit?.code ?? null, signal: forcedExit?.signal ?? "SIGKILL", forced: true };
    },
  };
}

/**
 * Attach to a Basecamp already running under the developer's own hands.
 *
 * Log fidelity is materially worse here: we cannot see the process's stdout,
 * so we tail the on-disk files. 0.2.2 writes them through a buffered QFile and
 * flushes only on rotation or exit; 0.3.0 flushes every line, but whether that
 * instance was started with Qt logging routed to the file at all cannot be
 * known from here. Callers must treat log-based verdicts from an attached
 * session as INCONCLUSIVE rather than PASS.
 */
export function attach(opts: { port?: number; logsDir?: string; commandTimeoutMs?: number }): Session {
  const port = opts.port ?? Number(process.env.QML_INSPECTOR_PORT ?? 3768);
  const inspector = new InspectorClient(
    opts.commandTimeoutMs !== undefined ? { port, timeoutMs: opts.commandTimeoutMs } : { port },
  );
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
      const timeoutMs = readyOpts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
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

/**
 * How long stop() keeps reading after Basecamp exits, for the lines still in
 * the pipe. Capped because a module host that outlives Basecamp for a moment
 * holds the same pipe open, and waiting for it to close is not worth a slower
 * stop.
 */
const SHUTDOWN_DRAIN_MS = 500;

/** Resolve once the child's stdio has closed, or after `ms`, whichever is first. */
/**
 * Close the child's stdout/stderr once nothing will read them again. Stopping the
 * source only detaches its listeners, which pauses a pipe without releasing it, so
 * a pipe that had not closed on its own (a killed child, or a drain that ran out)
 * would keep the event loop alive and outlive stop().
 */
function releasePipes(child: ChildProcess): void {
  for (const s of [child.stdout, child.stderr]) {
    if (s && !s.destroyed) s.destroy();
  }
}

function drainPipes(child: ChildProcess, ms: number): Promise<void> {
  const open = [child.stdout, child.stderr].filter((s) => s && !s.destroyed && !s.readableEnded);
  if (open.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    let left = open.length;
    function done(): void {
      clearTimeout(timer);
      resolve();
    }
    for (const s of open) {
      s!.once("close", () => {
        if (--left === 0) done();
      });
    }
  });
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
