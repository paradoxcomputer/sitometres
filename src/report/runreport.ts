// ---------------------------------------------------------------------------
// The run report.
//
// Printed at the end and written to disk, because the interesting part of a
// crawl is the table at the bottom, not the scroll above it — and because
// "what did this build do last time" is a question worth being able to diff.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import type { FidelityReport } from "../runner/fidelity.js";
import { describeOutcome, type Outcome } from "../runner/outcome.js";

const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const DIM = colour ? "\x1b[2m" : "";
const RST = colour ? "\x1b[0m" : "";
const RED = colour ? "\x1b[31m" : "";
const GRN = colour ? "\x1b[32m" : "";
const YEL = colour ? "\x1b[33m" : "";
const BOLD = colour ? "\x1b[1m" : "";

export interface RunReport {
  tool: "sitometres";
  version: string;
  startedAt: string;
  durationMs: number;
  app: {
    name: string;
    type: string;
    version?: string;
    dependencies: string[];
    builtFrom: string;
  } | null;
  basecamp: string;
  userDir: string | null;
  /** Throwaway $HOME the app saw, or null when it saw the real one. */
  sandboxHome?: string | null;
  wallet: string | null;
  fidelity: FidelityReport;
  open: { ok: boolean; nodes: number; calls: string[]; errors: string[] };
  clicks: Array<{
    label: string;
    type: string;
    outcome: Outcome;
    evidence: string[];
    calls: string[];
    reachedBy: string;
    /**
     * Text the click put on screen that was not there before.
     *
     * The crawl has computed this all along and threw it away. It is the only
     * thing it knows about an `unclear` click — the screen changed and nothing
     * said whether it worked — which is the outcome the docs call normal for
     * most controls in a real app, and the one a developer most needs explained.
     */
    newLabels?: string[];
  }>;
  /** The setup spec that ran before the crawl, if any. */
  setup: { file: string; steps: number } | null;
  untested: string[];
  /** Repeated list rows folded into a representative sample. */
  collapsedRows: number;
  problems: number;
  /** Controls deliberately not clicked, and why. Part of honest coverage. */
  skipped?: Array<{ label: string; why: string }>;
  /**
   * Set when the crawl ended because the app stopped responding.
   *
   * The report is still written — everything learned before the app died is
   * worth having — but a reader must be able to tell a crawl that finished
   * from one that was cut short, or the coverage numbers read as complete.
   */
  endedEarly?: string;
}

const MARK_TEXT: Record<Outcome, string> = {
  worked: "worked",
  ran: "ran",
  failed: "FAILED",
  unclear: "unclear",
  nothing: "no change seen",
};

const MARK_COLOUR: Record<Outcome, string> = {
  worked: GRN,
  ran: GRN,
  failed: RED,
  unclear: YEL,
  nothing: YEL,
};

/**
 * How wide the output may be.
 *
 * process.stdout.columns is undefined when piped, so honour $COLUMNS too — it
 * is the conventional override and it makes the layout testable without a pty.
 */
export function terminalWidth(): number {
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env > 20) return env;
  return process.stdout.columns ?? 100;
}

/** Column budget for the report table at a given terminal width. */
export function tableLayout(term: number, labels: string[]): { controlW: number; outcomeW: number; detailW: number } {
  const capped = Math.min(term, 140);
  const avail = capped - 4 - 10;
  const outcomeW = "no change seen".length;

  // One 38-character label ("Search by Txn Hash / Account / Channel") would
  // otherwise widen the name column and squeeze the evidence down to nothing —
  // and the evidence is the part worth reading. Names get what is left after
  // the detail column has enough room to say something.
  const wanted = Math.max(7, Math.max(1, ...labels.map((l) => l.length)));
  const detailFloor = Math.min(40, Math.max(24, Math.floor((avail - outcomeW) * 0.45)));
  const controlW = Math.max(7, Math.min(wanted, avail - outcomeW - detailFloor));
  const detailW = Math.max(12, avail - outcomeW - controlW);
  return { controlW, outcomeW, detailW };
}

/** Visible width, ignoring ANSI colour codes. */
function width(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, to: number): string {
  const w = width(s);
  return w >= to ? s : s + " ".repeat(to - w);
}

function clip(s: string, to: number): string {
  return s.length <= to ? s : s.slice(0, Math.max(0, to - 1)) + "…";
}

/**
 * Labels come from rich-text items verbatim, so zonescan's wordmark arrives as
 * "<b>zone</b>scan". Stripped for DISPLAY only — selectors still match the real
 * property value, markup and all.
 */
function plain(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim() || s;
}

/** The end-of-run table: one row per control, verdict beside it. */
export function printReport(r: RunReport): void {
  console.log(`\n  ${BOLD}Report${RST} ${DIM}— ${r.app?.name ?? "app"}${r.app?.version ? ` v${r.app.version}` : ""}${RST}`);

  if (r.clicks.length === 0) {
    console.log(`\n  ${DIM}no controls were clicked${RST}\n`);
    return;
  }

  // Budget the columns against the real terminal, so nothing wraps and the
  // borders stay square.
  const term = Math.min(terminalWidth(), 140);
  const { controlW, outcomeW, detailW } = tableLayout(term, r.clicks.map((c) => plain(c.label)));

  const line = (l: string, m: string, rgt: string) =>
    `  ${l}${"─".repeat(controlW + 2)}${m}${"─".repeat(outcomeW + 2)}${m}${"─".repeat(detailW + 2)}${rgt}`;

  console.log(line("┌", "┬", "┐"));
  console.log(
    `  │ ${pad(`${BOLD}Control${RST}`, controlW)} │ ${pad(`${BOLD}Outcome${RST}`, outcomeW)} │ ${pad(`${BOLD}What happened${RST}`, detailW)} │`,
  );
  console.log(line("├", "┼", "┤"));

  for (const c of r.clicks) {
    // "What happened" was blank for exactly the outcome that needs it most:
    // an `unclear` click carries no calls and no evidence by construction, so
    // the cell said nothing while the crawl held the list of what had appeared.
    const detail =
      c.calls.length > 0
        ? c.calls.join(", ")
        : c.evidence[0] ??
          (c.newLabels && c.newLabels.length > 0 ? `now shows: ${c.newLabels.slice(0, 3).join(", ")}` : "");
    console.log(
      `  │ ${pad(clip(plain(c.label), controlW), controlW)} │ ` +
        `${pad(`${MARK_COLOUR[c.outcome]}${MARK_TEXT[c.outcome]}${RST}`, outcomeW)} │ ` +
        `${pad(`${DIM}${clip(detail, detailW)}${RST}`, detailW)} │`,
    );
    // A failure's reason is the point of the run; give it its own line rather
    // than truncating it into the column.
    if (c.outcome === "failed") {
      // `detail` may already BE the reason when there were no calls to show;
      // repeating it under itself is just noise.
      const shown = c.evidence
        .filter((x) => /failed|error|reported:/.test(x))
        .filter((x) => x !== detail)
        .slice(0, 2);
      for (const e of shown) {
        console.log(`  │ ${" ".repeat(controlW)} │ ${" ".repeat(outcomeW)} │ ${pad(`${RED}${clip(e, detailW)}${RST}`, detailW)} │`);
      }
    }
  }
  console.log(line("└", "┴", "┘"));

  const n = (o: Outcome) => r.clicks.filter((c) => c.outcome === o).length;
  console.log(
    `  ${GRN}${n("worked")} worked${RST}  ${GRN}${n("ran")} ran${RST}  ` +
      `${RED}${n("failed")} failed${RST}  ${YEL}${n("unclear")} unclear${RST}  ${YEL}${n("nothing")} no change seen${RST}`,
  );

  const unconfirmed = n("ran");
  if (unconfirmed > 0) {
    console.log(
      `\n  ${DIM}"ran" means the call was dispatched, not that it succeeded — the module's` +
        `\n  answer goes back to QML, not to the log. To assert an outcome (a transfer` +
        `\n  settled, a token sent), name it in a spec: sitometres init ${r.app?.name ?? "<app>"}${RST}`,
    );
  }
  if (r.collapsedRows > 0) {
    console.log(
      `\n  ${DIM}${r.collapsedRows} repeated list row(s) skipped — same control, different data.${RST}`,
    );
  }
  if (r.untested.length > 0) {
    console.log(
      `\n  ${YEL}${r.untested.length} not reached${RST} ${DIM}— navigation moved on and neither going back` +
        `\n  nor re-opening brought them back: ${r.untested.slice(0, 6).map((u) => JSON.stringify(u)).join(", ")}${RST}`,
    );
  }
  if (r.fidelity.fidelity === "quiet") {
    console.log(`\n  ${YEL}!${RST} ${DIM}${r.fidelity.summary}${RST}`);
  }
}

/** Write the machine-readable copy and return where it went. */
export function writeReport(r: RunReport, file: string): string {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(r, null, 2) + "\n");
  return target;
}

export function defaultReportPath(app: string | null): string {
  return path.join(".sitometres", `${app ?? "run"}.json`);
}

export { describeOutcome };
