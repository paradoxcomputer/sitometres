// ---------------------------------------------------------------------------
// Where log lines come from.
//
// Basecamp redirects its own stdout AND stderr into a pipe; a reader thread
// then
//   (a) mirrors every byte to the ORIGINAL stdout — i.e. to whatever fd 1 was
//       at startup, which for a child we spawn is our pipe — and
//   (b) writes the same bytes into <userDir>/logs/basecamp_<stamp>.log.
//
// 0.2.2 does it with a LogRedirector (app/utils/LogRedirector.cpp) that writes
// through a QFile and rotates every 10 000 lines, forward, into
// basecamp_<stamp>.001.log, .002 and so on. Measured on this machine: the
// stdout mirror delivered its first line 517 ms after spawn, while the on-disk
// file was still 0 bytes six seconds in and only reached its full size after
// the process exited — QFile buffers and is flushed on rotation or close, not
// per line.
//
// 0.3.0 does it with a LogSink (app/utils/LogSink.cpp) over spdlog's rotating
// sink: the file is flushed every line, logs/basecamp.log is a symlink to the
// live file, and at 10 MB the live file is RENAMED to basecamp_<stamp>.1.log
// (the older ones shift up to .2, .3, ...) and a fresh one takes its name.
// A user-dir's config.yaml can move the directory, rename the file, or switch
// the stdout mirror off (`logging.console: false`).
//
// So: when sitometres owns the process, the child's stdout is the source fit
// for live correlation. File tailing exists for attach mode, where we cannot
// see the process's stdout, and for an owned 0.3.0 whose mirror is switched
// off. It says whether it lags, so the runner can downgrade log verdicts to
// INCONCLUSIVE instead of lying.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { LogBuffer, type LogOrigin } from "./buffer.js";
import { expandLine } from "./expand.js";

/**
 * Append one raw line, unpacking any ui-host envelope first so a view module's
 * own logging becomes individually matchable lines. See ./expand.ts.
 */
function appendRaw(buffer: LogBuffer, raw: string, origin: LogOrigin): void {
  for (const part of expandLine(raw)) {
    buffer.append(part.text, origin, part.viaUiHost);
  }
}

export interface LogSource {
  readonly kind: "child-stdout" | "file-tail";
  /** True when lines can arrive materially later than the event they describe. */
  readonly lagging: boolean;
  /** Human-readable description of what is being read, for the report header. */
  describe(): string;
  stop(): void;
}

/** Splits a byte stream into lines and feeds them to the buffer. */
function pumpLines(stream: Readable, buffer: LogBuffer, origin: LogOrigin): () => void {
  let carry = "";
  // Same reason as the inspector socket: a character split across two reads
  // must not become two replacement characters. A log line is compared against
  // `console:` expectations, so corruption here fails a real assertion.
  const decoder = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string) => {
    carry += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let idx: number;
    while ((idx = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, idx).replace(/\r$/, "");
      carry = carry.slice(idx + 1);
      appendRaw(buffer, line, origin);
    }
  };
  const onEnd = () => {
    if (carry.length > 0) {
      appendRaw(buffer, carry, origin);
      carry = "";
    }
  };
  stream.on("data", onData);
  stream.once("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    onEnd();
  };
}

/**
 * Primary source: the stdout (and, for the handful of lines emitted before the
 * redirector starts, stderr) of a Basecamp process we spawned.
 */
export class ChildStdoutSource implements LogSource {
  readonly kind = "child-stdout" as const;
  readonly lagging = false;
  private readonly detachers: Array<() => void> = [];
  private readonly streams: Readable[] = [];

  constructor(
    buffer: LogBuffer,
    streams: { stdout?: Readable | null; stderr?: Readable | null },
  ) {
    if (streams.stdout) {
      this.streams.push(streams.stdout);
      this.detachers.push(pumpLines(streams.stdout, buffer, "stdout"));
    }
    // Only pre-redirection output reaches the real stderr, but that window is
    // exactly where fatal early failures (missing Qt platform plugin, bad
    // --user-dir) show up, so it is worth capturing.
    if (streams.stderr) {
      this.streams.push(streams.stderr);
      this.detachers.push(pumpLines(streams.stderr, buffer, "stderr"));
    }
  }

  describe(): string {
    return "child stdout (live)";
  }

  stop(): void {
    for (const d of this.detachers) d();
    this.detachers.length = 0;
    // Detaching the listener only PAUSES the stream: the pipe handle stays open
    // and referenced, so the event loop never empties and the process hangs
    // around until something else kills it. The CLI never noticed, because it
    // ends with an explicit process.exit — but README advertises `boot`, `Runner`
    // and `dispose` as a library, and an embedder's process would simply refuse
    // to exit after a run. Measured: a test file of ten sessions took 11s to
    // finish 3s of work.
    for (const s of this.streams.splice(0)) s.destroy();
  }
}

/**
 * A session log: basecamp_<stamp>.log, then its rotations. 0.2.2 numbers them
 * forward with three digits (.001 is older than .002); 0.3.0's spdlog numbers
 * them backward (.1 is the newest rotated file, .2 is older).
 */
const LOG_NAME = /^basecamp_(\d{8}_\d{6})(?:\.(\d+))?\.log$/;

interface RotationFile {
  file: string;
  stamp: string;
  index: number;
}

/** The session-log pattern for a configured file name ("basecamp.log" by default). */
function logNameFor(file: string | undefined): RegExp {
  if (!file || file === "basecamp.log") return LOG_NAME;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc(stem)}_(\\d{8}_\\d{6})(?:\\.(\\d+))?${esc(ext)}$`);
}

/**
 * Where a file sits in its session, oldest first.
 *
 * 0.2.2's three-digit indices count forward from the base file. spdlog's count
 * backward and the base file is the live one, so it comes last.
 */
function rotationRank(f: { index: number; raw?: string }): number {
  if (f.index === 0) return f.raw === "spdlog" ? Number.MAX_SAFE_INTEGER : 0;
  return f.raw === "spdlog" ? -f.index : f.index;
}

export function listSessionLogs(logsDir: string, file?: string): RotationFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  const pattern = logNameFor(file);
  const parsed: Array<RotationFile & { raw?: string }> = [];
  const spdlogStamps = new Set<string>();
  for (const name of entries) {
    const m = pattern.exec(name);
    if (!m) continue;
    const idx = m[2];
    if (idx !== undefined && idx.length !== 3) spdlogStamps.add(m[1]!);
    parsed.push({ file: path.join(logsDir, name), stamp: m[1]!, index: idx ? Number(idx) : 0 });
  }
  for (const p of parsed) if (spdlogStamps.has(p.stamp)) p.raw = "spdlog";
  // Newest session first, then rotation order within a session, oldest part first.
  parsed.sort((a, b) => (a.stamp === b.stamp ? rotationRank(a) - rotationRank(b) : b.stamp.localeCompare(a.stamp)));
  return parsed.map(({ file: f, stamp, index }) => ({ file: f, stamp, index }));
}

/**
 * The stamp of the file 0.3.0's stable symlink points at, or null.
 *
 * The link is how Basecamp itself names the live session, so it beats the
 * newest stamp on disk when the two disagree.
 */
function linkedStamp(logsDir: string, file?: string): string | null {
  const link = path.join(logsDir, file ?? "basecamp.log");
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    const target = path.basename(fs.readlinkSync(link));
    return logNameFor(file).exec(target)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The rotation chain of the most recent session in `logsDir`, oldest part first. */
export function newestSessionChain(logsDir: string, file?: string): RotationFile[] {
  const all = listSessionLogs(logsDir, file);
  const linked = linkedStamp(logsDir, file);
  const stamp = linked !== null && all.some((f) => f.stamp === linked) ? linked : all[0]?.stamp;
  if (stamp === undefined) return [];
  // listSessionLogs already ordered each session's parts.
  return all.filter((f) => f.stamp === stamp);
}

/**
 * A file's identity across a rename. spdlog rotates by renaming the live file,
 * so a path names a different file after each rotation and an offset keyed by
 * path would be applied to the wrong one.
 */
function identity(st: fs.Stats): string {
  return `${st.dev}:${st.ino}`;
}

/**
 * Poll the newest session's log files and follow their rotation.
 *
 * The source behind attach mode, and behind an owned 0.3.0 whose stdout
 * mirror a config.yaml switched off. Lagging on 0.2.2 (see the file header);
 * not on 0.3.0, which flushes every line.
 */
export class FileTailSource implements LogSource {
  readonly kind = "file-tail" as const;

  private timer: NodeJS.Timeout | null = null;
  /** Byte offset already consumed, per file identity (device and inode). */
  private readonly offsets = new Map<string, number>();
  private stamp: string | null = null;
  private stopped = false;

  constructor(
    private readonly logsDir: string,
    private readonly buffer: LogBuffer,
    private readonly opts: { intervalMs?: number; fromStart?: boolean; file?: string } = {},
  ) {
    const chain = newestSessionChain(this.logsDir, this.opts.file);
    this.stamp = chain[0]?.stamp ?? null;
    if (!this.opts.fromStart) {
      // Start at end-of-file: attach mode only cares about what happens next.
      for (const f of chain) {
        try {
          const st = fs.statSync(f.file);
          this.offsets.set(identity(st), st.size);
        } catch {
          /* gone between the listing and the stat: nothing to skip */
        }
      }
    }
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 200);
    this.timer.unref?.();
  }

  /**
   * True unless this is 0.3.0's per-line-flushed log: its stable symlink is
   * there, or the session's first line names 0.3 or later.
   */
  get lagging(): boolean {
    if (linkedStamp(this.logsDir, this.opts.file) !== null) return false;
    const first = newestSessionChain(this.logsDir, this.opts.file)[0];
    if (!first) return true;
    try {
      const fd = fs.openSync(first.file, "r");
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      fs.closeSync(fd);
      const m = /^LogosBasecamp version (\d+)\.(\d+)/.exec(buf.subarray(0, n).toString("utf8"));
      return !(m && (Number(m[1]) > 0 || Number(m[2]) >= 3));
    } catch {
      return true;
    }
  }

  describe(): string {
    return this.lagging
      ? `${this.logsDir} (file tail — lags, Basecamp buffers these writes)`
      : `${this.logsDir} (file tail, flushed per line)`;
  }

  private poll(): void {
    if (this.stopped) return;
    const chain = newestSessionChain(this.logsDir, this.opts.file);
    if (chain.length === 0) return;

    // A brand-new session (the app restarted under us) resets our offsets.
    const currentStamp = chain[0]!.stamp;
    if (this.stamp !== null && currentStamp !== this.stamp) {
      this.offsets.clear();
      this.stamp = currentStamp;
    } else if (this.stamp === null) {
      this.stamp = currentStamp;
    }

    for (const part of chain) {
      let st: fs.Stats;
      try {
        st = fs.statSync(part.file);
      } catch {
        continue;
      }
      const key = identity(st);
      let from = this.offsets.get(key) ?? 0;
      const size = st.size;
      // The same file, shorter than what was read of it: truncated and
      // rewritten, so what is there now is new.
      if (size < from) from = 0;
      if (size <= from) continue;
      let text: string;
      try {
        const fd = fs.openSync(part.file, "r");
        const buf = Buffer.allocUnsafe(size - from);
        fs.readSync(fd, buf, 0, size - from, from);
        fs.closeSync(fd);
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      // Only consume up to the last complete line; the rest waits for the next poll.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) continue;
      this.offsets.set(key, from + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8"));
      for (const line of text.slice(0, lastNl).split("\n")) {
        appendRaw(this.buffer, line.replace(/\r$/, ""), "file");
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.poll(); // one last drain
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Two sources feeding one buffer: an owned Basecamp's stdout, which still
 * carries what it prints before its log redirect starts, and its log file,
 * when a config.yaml switched the stdout mirror off. Nothing reaches both.
 */
export class MergedSource implements LogSource {
  readonly kind: LogSource["kind"];

  constructor(private readonly sources: LogSource[]) {
    this.kind = sources.some((x) => x.kind === "file-tail") ? "file-tail" : "child-stdout";
  }

  get lagging(): boolean {
    return this.sources.some((x) => x.lagging);
  }

  describe(): string {
    return this.sources.map((x) => x.describe()).join(" + ");
  }

  stop(): void {
    for (const x of this.sources) x.stop();
  }
}
