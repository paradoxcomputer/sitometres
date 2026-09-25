// ---------------------------------------------------------------------------
// How much can this Basecamp build actually tell us?
//
// The `LogosAPIClient: invoking remote method …` trail that makes call
// assertions possible comes from qDebug(), and whether it is observable is a
// runtime property, not a build one.
//
// Qt here is built with journald support, so by default qDebug/qInfo/qWarning
// go to the systemd journal and never touch stderr — which means Basecamp's
// LogRedirector never sees them and the stream carries five lines for a whole
// session. QT_FORCE_STDERR_LOGGING=1 routes them back to stderr and the same
// binary emits the full trail (measured: 5 lines vs 242). We set that variable
// whenever we launch the app, so an owned session is normally "verbose".
//
// It can still be quiet: --attach cannot set the variable on someone else's
// process, a caller may pass forceStderrLogging: false, and a build really
// could have logging compiled out. Rather than silently reporting PASS for
// evidence we cannot see, we detect fidelity up front and downgrade log-based
// verdicts to INCONCLUSIVE with the remedy attached.
//
// Detection is non-invasive. Basecamp's capability handshake exchanges module
// tokens during startup on every run, so a logging-enabled build ALWAYS emits
// LogosAPIClient/LogosObject chatter before the UI is up. Zero such lines by
// the time the shell has rendered means Qt logging is compiled out.
//
// "Verbose" is not the whole answer on Basecamp 0.3.0, which has two more
// channels that are off by default and that the Basecamp process's own Qt
// lines say nothing about:
//
//   hostDebug  a module host's qDebug, which is where `emitEvent` is logged.
//              0.2.2 prints it at info; 0.3.0 at debug, which liblogos drops
//              unless LOGOS_LOG_LEVEL=debug.
//   viewHost   a view module's ui-host output, which carries every call that
//              app makes. 0.2.2 forwards it with plain qDebug; 0.3.0 under the
//              logos.viewhost category, which is off unless QT_LOGGING_RULES
//              says `logos.viewhost.debug=true`.
//
// sitometres turns both on when it launches Basecamp, so each is reported
// separately: a user rule can still switch one off, and an attached Basecamp
// was started by somebody else.
// ---------------------------------------------------------------------------

import type { LogBuffer, LogCursor, LogLine } from "../logs/buffer.js";

export type LogFidelity = "verbose" | "quiet";

export interface FidelityReport {
  fidelity: LogFidelity;
  /** Lines seen from the Qt logging families during startup. */
  qtLogLines: number;
  /** Structured spdlog lines from module hosts; these survive either way. */
  moduleLogLines: number;
  /** What this means for assertions, in one sentence. */
  summary: string;
  /** How to get the missing evidence back, when it is missing. */
  remedy?: string;
  /**
   * The Basecamp version from its first line of output ("LogosBasecamp version
   * 0.3.0 (dev build)"), when it printed one.
   */
  basecampVersion?: string;
  /**
   * The two channels a Qt-verbose log can still be missing; see the file
   * header. Absent from a report built by hand, which means "not measured".
   */
  channels?: FidelityChannels;
}

export interface FidelityChannels {
  /** A module host's debug output reaches the log: `events:` can be read. */
  hostDebug: boolean;
  /**
   * A view module's ui-host output has reached the log. Only meaningful once
   * such an app has opened; before that there is nothing to forward.
   */
  viewHost: boolean;
}

/** The first line Basecamp prints, on both 0.2.2 and 0.3.0. */
const BANNER = /^LogosBasecamp version (\S+)/;

/** The Basecamp version a banner line names, or null. */
export function parseBanner(text: string): string | null {
  return BANNER.exec(text)?.[1] ?? null;
}

/** A module host's own output: any debug-level line, or 0.2.2's info-level host line. */
const HOST_DEBUG = /^\[\d{4}-\d{2}-\d{2} [\d:.]+\] \[(?:debug|trace)\] |^\[\d{4}-\d{2}-\d{2} [\d:.]+\] \[info\] \[(?:logos\] \[[a-z][a-z0-9_]*|(?!logos\])[A-Za-z0-9_.-]+)\] /;
/** A ui-host's forwarded output, in either version's spelling. */
const VIEW_HOST = /^(?:logos\.viewhost: |ViewModuleHost: |ui-host \[ ")/;

export function isHostDebugLine(line: Pick<LogLine, "text">): boolean {
  return HOST_DEBUG.test(line.text);
}

export function isViewHostLine(line: Pick<LogLine, "text" | "viaUiHost">): boolean {
  return line.viaUiHost !== undefined || VIEW_HOST.test(line.text);
}

/** How to turn the host-debug channel back on. */
export const HOST_DEBUG_REMEDY =
  "Module hosts' debug output is not reaching this run, and that is where a module's events are logged. " +
  "On Basecamp 0.3.0 it needs LOGOS_LOG_LEVEL=debug in the app's environment, which sitometres sets " +
  "unless LOGOS_LOG_LEVEL or SPDLOG_LEVEL is already set; --env LOGOS_LOG_LEVEL=debug restores it.";

/** How to turn the view-host channel back on. */
export const VIEW_HOST_REMEDY =
  "This app runs in a ui-host process, and none of its output reached this run, so its backend calls " +
  "cannot be seen. On Basecamp 0.3.0 that output is logged under logos.viewhost, which needs " +
  "QT_LOGGING_RULES=logos.viewhost.debug=true; sitometres puts that rule first, so a later rule of " +
  "yours that switches it off wins.";

/**
 * Which channels have shown themselves so far, reading each line once.
 *
 * A channel only ever turns on: a host that has logged has proved the channel
 * works, and a run asks at every step.
 */
export class ChannelTracker {
  private next: LogCursor = 0;
  private readonly seen: FidelityChannels = { hostDebug: false, viewHost: false };

  observe(logs: { slice(from: LogCursor): LogLine[] }): FidelityChannels {
    if (this.seen.hostDebug && this.seen.viewHost) return { ...this.seen };
    const fresh = logs.slice(this.next);
    const last = fresh[fresh.length - 1];
    if (last) {
      this.next = last.seq + 1;
      for (const l of fresh) {
        if (!this.seen.hostDebug && isHostDebugLine(l)) this.seen.hostDebug = true;
        if (!this.seen.viewHost && isViewHostLine(l)) this.seen.viewHost = true;
      }
    }
    return { ...this.seen };
  }
}

const QT_FAMILY = /^(LogosAPIClient:|LogosAPIConsumer:|\[LogosObject\]|RemoteLogosObject|RemoteTransportConnection:|qml: |qt\.)/;

/**
 * What Basecamp's own configuration did to its log, when a caller-supplied
 * user-dir holds a 0.3.0 config.yaml. See readLoggingConfig in ../app/userdir.ts.
 */
export interface FidelityContext {
  logging?: { enabled: boolean; console: boolean; configPath: string };
}

export function assessFidelity(logs: LogBuffer, context: FidelityContext = {}): FidelityReport {
  const lines = logs.slice(0);
  let qtLogLines = 0;
  let moduleLogLines = 0;
  let basecampVersion: string | undefined;
  const channels: FidelityChannels = { hostDebug: false, viewHost: false };
  for (const l of lines) {
    if (QT_FAMILY.test(l.text)) qtLogLines++;
    else if (/^\[\d{4}-\d{2}-\d{2} /.test(l.text)) moduleLogLines++;
    if (basecampVersion === undefined) {
      const v = parseBanner(l.text);
      if (v !== null) basecampVersion = v;
    }
    if (!channels.hostDebug && isHostDebugLine(l)) channels.hostDebug = true;
    if (!channels.viewHost && isViewHostLine(l)) channels.viewHost = true;
  }
  const measured = { ...(basecampVersion !== undefined ? { basecampVersion } : {}), channels };

  if (qtLogLines > 0) {
    return {
      fidelity: "verbose",
      qtLogLines,
      moduleLogLines,
      summary: "Qt logging is on — backend calls, QML errors and console output are all observable.",
      ...measured,
    };
  }

  const logging = context.logging;
  if (logging && !logging.enabled) {
    return {
      fidelity: "quiet",
      qtLogLines,
      moduleLogLines,
      summary: "Basecamp's logging is switched off for this user-dir, so backend calls, QML errors and console.log are invisible.",
      remedy:
        `${logging.configPath} sets logging.enabled: false. sitometres never edits that file; ` +
        "set it to true, or run without --user-dir so the run gets a user-dir of its own.",
      ...measured,
    };
  }

  return {
    fidelity: "quiet",
    qtLogLines,
    moduleLogLines,
    ...measured,
    summary:
      "No Qt logging is reaching this session, so backend calls, QML errors and " +
      "console.log are invisible.",
    remedy:
      "Qt sends those to journald unless QT_FORCE_STDERR_LOGGING=1 is set in the app's " +
      "environment. sitometres sets it when it launches Basecamp itself, so if you are " +
      "seeing this you are probably attached to an instance started without it — relaunch " +
      "that instance with QT_FORCE_STDERR_LOGGING=1, or let sitometres launch the app. " +
      "Until then, call and error assertions report INCONCLUSIVE, and `expect.state` is " +
      "the oracle that always works.",
  };
}
