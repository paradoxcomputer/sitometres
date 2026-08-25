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
// ---------------------------------------------------------------------------

import type { LogBuffer } from "../logs/buffer.js";

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
}

const QT_FAMILY = /^(LogosAPIClient:|LogosAPIConsumer:|\[LogosObject\]|RemoteLogosObject|RemoteTransportConnection:|qml: |qt\.)/;

export function assessFidelity(logs: LogBuffer): FidelityReport {
  const lines = logs.slice(0);
  let qtLogLines = 0;
  let moduleLogLines = 0;
  for (const l of lines) {
    if (QT_FAMILY.test(l.text)) qtLogLines++;
    else if (/^\[\d{4}-\d{2}-\d{2} /.test(l.text)) moduleLogLines++;
  }

  if (qtLogLines > 0) {
    return {
      fidelity: "verbose",
      qtLogLines,
      moduleLogLines,
      summary: "Qt logging is on — backend calls, QML errors and console output are all observable.",
    };
  }

  return {
    fidelity: "quiet",
    qtLogLines,
    moduleLogLines,
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
