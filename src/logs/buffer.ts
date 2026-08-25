// ---------------------------------------------------------------------------
// An append-only, cursor-addressable buffer of log lines.
//
// Every step of a test brackets its UI action with a cursor, so the evidence
// for that step is exactly the lines that arrived inside the bracket. Waiting
// is event-driven: a waiter is woken by the arriving line, not by a poll, so a
// step finishes as soon as its evidence lands instead of burning its timeout.
// ---------------------------------------------------------------------------

export interface LogLine {
  /** Monotonic index within the run, starting at 0. */
  seq: number;
  /** Milliseconds since the buffer was created (i.e. since app launch). */
  atMs: number;
  /** Wall-clock receive time. Not the timestamp embedded in the line. */
  received: Date;
  text: string;
  /** Which stream carried it. */
  origin: LogOrigin;
  /** Set when the line was unpacked from a `ui-host [ "<module>" ]: "..."`
   *  envelope, naming the child view-module process that really emitted it. */
  viaUiHost?: string;
}

export type LogOrigin = "stdout" | "stderr" | "file";

/** An opaque position in the stream. Just the next sequence number. */
export type LogCursor = number;

type Waiter = {
  test: (line: LogLine) => boolean;
  resolve: (line: LogLine) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  from: LogCursor;
};

export class LogBuffer {
  private readonly lines: LogLine[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly startedAt = Date.now();
  private closedReason: string | null = null;

  /** Cap retained lines so a chatty app cannot exhaust memory on a long run. */
  constructor(private readonly maxLines = 200_000) {}

  get length(): number {
    return this.lines.length;
  }

  /** A cursor pointing just past the last line received so far. */
  mark(): LogCursor {
    return this.lines.length === 0 ? 0 : this.lines[this.lines.length - 1]!.seq + 1;
  }

  append(text: string, origin: LogOrigin, viaUiHost?: string): LogLine {
    const seq = this.mark();
    const line: LogLine = { seq, atMs: Date.now() - this.startedAt, received: new Date(), text, origin };
    if (viaUiHost) line.viaUiHost = viaUiHost;
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    for (const w of [...this.waiters]) {
      if (line.seq >= w.from && w.test(line)) {
        this.waiters.delete(w);
        if (w.timer) clearTimeout(w.timer);
        w.resolve(line);
      }
    }
    return line;
  }

  /** Lines in [from, to). `to` defaults to "everything received so far". */
  slice(from: LogCursor, to: LogCursor = Number.MAX_SAFE_INTEGER): LogLine[] {
    return this.lines.filter((l) => l.seq >= from && l.seq < to);
  }

  /** The most recent `n` lines — used to give failures some surrounding context. */
  tail(n: number): LogLine[] {
    return this.lines.slice(-n);
  }

  /**
   * Resolve with the first line at or after `from` satisfying `test`.
   * Scans what has already arrived before parking, so a cursor taken before a
   * fast action still sees evidence that landed in the meantime.
   */
  waitFor(
    test: (line: LogLine) => boolean,
    opts: { from?: LogCursor; timeoutMs?: number } = {},
  ): Promise<LogLine> {
    const from = opts.from ?? 0;
    const timeoutMs = opts.timeoutMs ?? 10_000;

    for (const line of this.lines) {
      if (line.seq >= from && test(line)) return Promise.resolve(line);
    }
    if (this.closedReason) {
      return Promise.reject(new LogWaitError(`log stream ended (${this.closedReason}) before a matching line arrived`, from));
    }

    return new Promise<LogLine>((resolve, reject) => {
      const waiter: Waiter = {
        test,
        resolve,
        reject,
        from,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new LogWaitError(`no matching log line within ${timeoutMs}ms`, from));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Mark the stream finished; parks are released so nothing hangs on exit. */
  close(reason: string): void {
    this.closedReason = reason;
    for (const w of [...this.waiters]) {
      this.waiters.delete(w);
      if (w.timer) clearTimeout(w.timer);
      w.reject(new LogWaitError(`log stream ended (${reason}) before a matching line arrived`, w.from));
    }
  }
}

export class LogWaitError extends Error {
  constructor(message: string, readonly from: LogCursor) {
    super(message);
    this.name = "LogWaitError";
  }
}
