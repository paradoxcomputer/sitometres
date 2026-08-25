// ---------------------------------------------------------------------------
// The always-visible status line.
//
// Runs are long and mostly silent: staging copies trees, Basecamp takes a
// couple of seconds to start, and a heavyweight plugin like medusa_ui can be a
// minute before its dock appears. Without a heartbeat the tool looks hung
// exactly when it is working hardest.
//
// On a TTY this is one line, rewritten in place, that always says which phase
// we are in and how long it has been going. Anything printed while it is live
// is written above it, so the scrollback stays clean.
//
// Off a TTY — CI, a pipe, a log file — an animation would be noise, so each
// distinct step is printed once as a plain line instead.
// ---------------------------------------------------------------------------

export type Phase = "Preparing" | "Running" | "Completed" | "Failed";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR = "\x1b[2K\r";

const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const DIM = colour ? "\x1b[2m" : "";
const RST = colour ? "\x1b[0m" : "";
const CYA = colour ? "\x1b[36m" : "";
const GRN = colour ? "\x1b[32m" : "";
const RED = colour ? "\x1b[31m" : "";

/**
 * Trim the detail so the whole line fits on one row.
 *
 * Wrap protection, not cosmetics: \x1b[2K erases one PHYSICAL line, so a status
 * line that wrapped leaves its overflow on screen and every later print lands
 * beside the leftovers — which is exactly how a report ends up reading
 * "Running · …asking Basecamp  FAIL open zonescan_lite".
 *
 * Exported for tests; the visible width is what matters, so escape codes are
 * excluded from the budget by construction (none are in the measured parts).
 */
export function fitDetail(phase: string, detail: string, secs: string, width: number): string {
  //  "  " + spinner + " " + phase + " · " + detail + " " + secs
  const fixed = 2 + 1 + 1 + phase.length + 3 + 1 + secs.length;
  const room = width - fixed;
  if (room <= 1) return "";
  if (detail.length <= room) return detail;
  return detail.slice(0, room - 1) + "…";
}

class StatusLine {
  private phase: Phase = "Preparing";
  private detail = "";
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private startedAt = Date.now();
  private phaseAt = Date.now();
  private live = false;
  private originalLog: typeof console.log | null = null;
  private lastPrinted = "";

  private get interactive(): boolean {
    return Boolean(process.stdout.isTTY) && process.env.SITOMETRES_NO_STATUS === undefined;
  }

  start(phase: Phase = "Preparing", detail = ""): void {
    if (this.live) {
      this.set(phase, detail);
      return;
    }
    this.live = true;
    this.startedAt = Date.now();
    this.set(phase, detail);
    if (!this.interactive) return;

    // Everything else in the tool prints with console.log. Rather than thread a
    // writer through every call site, take it over while the line is live:
    // erase, print, redraw. Restored in stop().
    this.originalLog = console.log;
    console.log = (...args: unknown[]) => {
      process.stdout.write(CLEAR);
      this.originalLog!(...args);
      this.render();
    };

    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, 100);
    this.timer.unref?.();
  }

  /** Change what the line says. Cheap; call it as often as it is accurate. */
  set(phase: Phase, detail = ""): void {
    const changedPhase = phase !== this.phase;
    this.phase = phase;
    this.detail = detail;
    if (changedPhase) this.phaseAt = Date.now();
    if (!this.live) return;
    if (this.interactive) {
      this.render();
      return;
    }
    // Non-interactive: one line per distinct step. Elapsed-time counters differ
    // every second and would otherwise fill a CI log with the same sentence.
    //
    // On stderr, because off a TTY stdout may be a data channel: `sitometres
    // inspect <app> --json | jq` used to receive a variable number of
    // `  [Preparing] …` lines interleaved with the JSON document and fail to
    // parse, and no flag suppressed them — `--quiet` covers the banner only and
    // SITOMETRES_NO_STATUS the TTY spinner only. Progress narration is
    // diagnostic output; it belongs beside the errors, not in the payload.
    const key = `${phase}|${detail.replace(/\(\d+s\)\s*$/, "").trim()}`;
    if (key !== this.lastPrinted) {
      this.lastPrinted = key;
      process.stderr.write(`  [${phase}] ${detail}\n`);
    }
  }

  private render(): void {
    if (!this.live || !this.interactive) return;
    const spin = this.phase === "Preparing" || this.phase === "Running" ? FRAMES[this.frame]! : " ";
    const tint = this.phase === "Completed" ? GRN : this.phase === "Failed" ? RED : CYA;
    const secs = `${Math.round((Date.now() - this.startedAt) / 1000)}s`;
    const detailText = fitDetail(this.phase, this.detail, secs, process.stdout.columns ?? 80);
    const detail = detailText ? ` ${DIM}·${RST} ${detailText}` : "";
    process.stdout.write(`${CLEAR}  ${tint}${spin} ${this.phase}${RST}${detail} ${DIM}${secs}${RST}`);
  }

  /** Freeze the line on a final phase and hand stdout back. */
  stop(phase: Phase = "Completed", detail = ""): void {
    if (!this.live) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.originalLog) {
      console.log = this.originalLog;
      this.originalLog = null;
    }
    this.live = false;
    if (!this.interactive) {
      // stderr, for the same reason as set(): off a TTY, stdout may be a
      // machine-readable payload and this is narration about the run.
      process.stderr.write(`  [${phase}]${detail ? ` ${detail}` : ""}\n`);
      return;
    }
    const tint = phase === "Failed" ? RED : GRN;
    const secs = Math.round((Date.now() - this.startedAt) / 1000);
    const suffix = detail ? ` ${DIM}·${RST} ${detail}` : "";
    process.stdout.write(`${CLEAR}  ${tint}${phase}${RST}${suffix} ${DIM}in ${secs}s${RST}\n`);
  }

  /** Update the detail, keeping the current phase. */
  detailOnly(detail: string): void {
    this.set(this.phase, detail);
  }

  /** Erase without printing anything — for handing over to an error report. */
  clear(): void {
    if (this.live && this.interactive) process.stdout.write(CLEAR);
  }

  /**
   * Stop repainting, and hand the terminal over.
   *
   * clear() erased the line once but left the 100 ms ticker running, so
   * anything that then waits for the user — the debug prompt, the first-run
   * Basecamp question — had its prompt wiped ~100 ms after it appeared, and the
   * cursor left wherever the spinner put it. Anything that reads from the
   * terminal must suspend first and resume afterwards.
   */
  suspend(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clear();
  }

  /** Resume repainting after a suspend(). Safe to call when never suspended. */
  resume(): void {
    if (!this.live || !this.interactive || this.timer) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, 100);
    this.timer.unref?.();
  }
}

export const status = new StatusLine();
