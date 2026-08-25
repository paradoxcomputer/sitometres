// ---------------------------------------------------------------------------
// Where log lines come from.
//
// Basecamp installs a LogRedirector (app/utils/LogRedirector.cpp) that dup2()s
// its own stdout AND stderr into a pipe; a reader thread then
//   (a) mirrors every byte to the ORIGINAL stdout — i.e. to whatever fd 1 was
//       at startup, which for a child we spawn is our pipe — and
//   (b) writes the same bytes into <userDir>/logs/basecamp_<stamp>[.NNN].log,
//       rotating every 10 000 lines.
//
// Measured on this machine: the stdout mirror delivered its first line 517 ms
// after spawn, while the on-disk file was still 0 bytes six seconds in and
// only reached its full size after the process exited — QFile buffers and is
// flushed on rotation or close, not per line.
//
// So: when sitometres owns the process, the child's stdout is the ONLY source
// fit for live correlation. File tailing exists solely for attach mode, where
// we cannot see the process's stdout, and it is explicitly marked as lagging
// so the runner can downgrade log verdicts to INCONCLUSIVE instead of lying.
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

const LOG_NAME = /^basecamp_(\d{8}_\d{6})(?:\.(\d{3}))?\.log$/;

interface RotationFile {
  file: string;
  stamp: string;
  index: number;
}

export function listSessionLogs(logsDir: string): RotationFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  const parsed: RotationFile[] = [];
  for (const name of entries) {
    const m = LOG_NAME.exec(name);
    if (!m) continue;
    parsed.push({ file: path.join(logsDir, name), stamp: m[1]!, index: m[2] ? Number(m[2]) : 0 });
  }
  // Newest session first, then rotation order within a session.
  parsed.sort((a, b) => (a.stamp === b.stamp ? a.index - b.index : b.stamp.localeCompare(a.stamp)));
  return parsed;
}

/** The rotation chain of the most recent session in `logsDir`, oldest part first. */
export function newestSessionChain(logsDir: string): RotationFile[] {
  const all = listSessionLogs(logsDir);
  const newest = all[0];
  if (!newest) return [];
  return all.filter((f) => f.stamp === newest.stamp).sort((a, b) => a.index - b.index);
}

/**
 * Fallback source for attach mode: poll the newest session's log files and
 * follow rotation into basecamp_<stamp>.NNN.log.
 *
 * Lagging by construction — see the file header.
 */
export class FileTailSource implements LogSource {
  readonly kind = "file-tail" as const;
  readonly lagging = true;

  private timer: NodeJS.Timeout | null = null;
  /** Byte offset already consumed, per file path. */
  private readonly offsets = new Map<string, number>();
  private stamp: string | null = null;
  private stopped = false;

  constructor(
    private readonly logsDir: string,
    private readonly buffer: LogBuffer,
    private readonly opts: { intervalMs?: number; fromStart?: boolean } = {},
  ) {
    const chain = newestSessionChain(this.logsDir);
    this.stamp = chain[0]?.stamp ?? null;
    if (!this.opts.fromStart) {
      // Start at end-of-file: attach mode only cares about what happens next.
      for (const f of chain) {
        try {
          this.offsets.set(f.file, fs.statSync(f.file).size);
        } catch {
          this.offsets.set(f.file, 0);
        }
      }
    }
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 200);
    this.timer.unref?.();
  }

  describe(): string {
    return `${this.logsDir} (file tail — lags, Basecamp buffers these writes)`;
  }

  private poll(): void {
    if (this.stopped) return;
    let chain = newestSessionChain(this.logsDir);
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
      const from = this.offsets.get(part.file) ?? 0;
      let size: number;
      try {
        size = fs.statSync(part.file).size;
      } catch {
        continue;
      }
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
      this.offsets.set(part.file, from + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8"));
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
