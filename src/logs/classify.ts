// ---------------------------------------------------------------------------
// Turning Basecamp log lines into semantic signals.
//
// Two line shapes reach the stream:
//
//   1. Plain Qt output from the Basecamp process itself
//        LogosAPIClient: invoking remote method "medusa_core" "getWalletState" args_count: 0
//   2. Structured output from a module host process, whose stdout is inherited
//      from Basecamp and therefore lands in the same pipe. The logger is
//      liblogos's "logos", and the host's own module name follows it:
//        [2026-09-24 23:04:55.382] [info] [logos] [package_manager] ModuleProxy: ...   (0.2.2)
//        [2026-09-24 23:07:44.238] [debug] [logos] [modules_state] Debug: ...          (0.3.0)
//      Older builds named the logger after the module instead:
//        [2026-08-04 18:14:09.123] [info] [package_manager] [LogosProviderObject] ...
//      0.3.0's host message handler adds a Qt severity word ("Debug: ",
//      "Warning: ") and routes qDebug to spdlog's debug level, which liblogos
//      drops unless LOGOS_LOG_LEVEL=debug (sitometres sets it; see
//      buildLaunchEnv in ../app/lifecycle.ts).
//
// A structured line's message can itself be a plain signal, so we strip the
// prefix first and classify the remainder. That is how a call made *by a
// module* is caught as well as one made by the UI.
//
// Basecamp 0.3.0 changed several of the lines below: the transport's failure
// line split in two, a module that is not reachable yet now fails in 1.5 s
// with a replica-acquire line instead of a transport timeout, an async call to
// such a module is HELD rather than dispatched, and every first call to a
// module now starts with a token handshake of its own. Each pattern says which
// Basecamp prints it; the captured lines are in tests/fixtures/basecamp-logs.
//
// Every pattern below was counted against the real log corpus in
// ~/.local/share/Logos/LogosBasecampDev/logs (match counts in comments) rather
// than written from imagination.
// ---------------------------------------------------------------------------

import type { LogCursor, LogLine } from "./buffer.js";

/** spdlog levels, plus "out": the container's logger for a host's raw stdout. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "warning" | "error" | "critical" | "out";

export type SignalKind =
  /** A remote module method call left the caller. The only "it was called" proof. */
  | "call_started"
  /**
   * An ASYNCHRONOUS call left the caller. `logos.callModuleAsync` emits no
   * `invoking remote method` line at all, so without this the whole async half
   * of the bridge API was invisible to `calls:` and `no_calls:`.
   */
  | "call_started_async"
  /**
   * Names the module a following async dispatch is aimed at. The async lines
   * carry only the method, so the module is recovered from the nearest
   * preceding one of these — see qualifyCalls().
   */
  | "module_context"
  /** The consumer handed the call to the transport; carries the call timeout. */
  | "call_dispatched"
  /** The transport actually issued the call. This is the anchor a later
   *  call_failed is paired against — see pairFailures(). */
  | "transport_call"
  /** A call failed or timed out. The only "it went wrong" proof. */
  | "call_failed"
  /**
   * An asynchronous call to a module that is not reachable yet, held instead
   * of dispatched (0.3.0). A later async dispatch to the same module means it
   * went through; `still not reachable after N ms` means it did not.
   */
  | "call_held"
  /**
   * A capability exchange was refused: the handshake came back with no token,
   * a provider rejected a call's token, or an identity with no credential is
   * about to be refused. "No token found" is NOT one: it is logged on every
   * first contact, and is a module_context with detail "no token".
   */
  | "auth_denied"
  /** A module published a typed event. */
  | "event_emitted"
  /** A consumer subscribed to a typed event. */
  | "event_subscribed"
  | "module_loaded"
  | "ui_module_loaded"
  | "ui_module_load_failed"
  /** The app's QML would not compile. Carries the compiler's file:line:col. */
  | "ui_compile_failed"
  /** A core module the app declares could not be loaded. */
  | "core_dependency_failed"
  /** The out-of-process ui-host never signalled ready. */
  | "ui_host_timeout"
  /**
   * 0.3.0 refused to load a UI module whose core dependencies are missing or
   * outside the declared range, and showed a popup instead. `detail` is
   * Basecamp's own one-word summary ("missing", "mismatch", "signer").
   */
  | "ui_module_blocked"
  /**
   * 0.3.0 parked a UI module's load until the launcher's dependency data
   * arrives. Harmless when a load line follows; the whole story when none does.
   */
  | "ui_module_deferred"
  /** A warning from the QML bridge (LogosQmlBridge / logos.qmlbridge). */
  | "bridge_warning"
  /** The app used the bridge wrongly, e.g. logos.callModule on a view module. */
  | "bridge_misuse"
  /** A view module's ui-host process crashed. `target` names it. */
  | "view_module_crashed"
  | "ui_module_unloaded"
  | "core_started"
  /** A QML runtime error — file path tells us whose app it is. */
  | "qml_error"
  /** A non-fatal QML diagnostic: missing asset, binding loop, bad anchor. */
  | "qml_warning"
  /** console.log() from QML. An app's own success oracle. */
  | "qml_console";

export interface Signal {
  kind: SignalKind;
  /** Module being called / loaded / reporting, when the line names one. */
  target?: string;
  /** Method name for call_* signals; event name for event_* signals. */
  method?: string;
  argCount?: number;
  timeoutMs?: number;
  /** Source location for qml_error. */
  file?: string;
  lineNo?: number;
  errorType?: string;
  /** Free-text remainder, e.g. the reason a UI module failed to load. */
  detail?: string;
  /**
   * A dispatch the protocol makes for itself, not for the app: the capability
   * handshake's requestModule / informModuleToken. Kept as a pairing anchor so
   * a handshake timeout is still caught, never reported as a call the app made.
   */
  internal?: boolean;
  /**
   * How a call_failed is paired back to the call it belongs to:
   *   transport     the transport gave up on a dispatched call; the nearest
   *                 preceding transport line is the victim (the default)
   *   null-replica  refused before the transport line was printed
   *   acquire       the module's replica was never acquired; names the module
   *   unreachable   a held call's module was still not reachable; names it
   */
  failure?: "transport" | "null-replica" | "acquire" | "unreachable";
  /** For an `unreachable` failure: how long the call had been held. */
  elapsedMs?: number;
}

export interface ParsedLine {
  line: LogLine;
  /** Timestamp text from a structured prefix, if any. Not parsed into a Date:
   *  it is the emitting process's clock, and we order by arrival instead. */
  stamp?: string;
  level?: LogLevel;
  /** Emitting module name from a structured prefix, e.g. "package_manager". */
  module?: string;
  /** Message with any structured prefix removed. */
  message: string;
  signal?: Signal;
  /** True when the line indicates something went wrong, regardless of signal. */
  isError: boolean;
}

/**
 * An spdlog line: stamp, level, logger, then (for a module host) the host's
 * module in its own brackets, then 0.3.0's Qt severity word, then the message.
 *
 * Only a lower-case bracket right after the logger is the host's module name:
 * `[LogosProviderObject]` is part of the message, and so is the second
 * timestamp on an `[out]` line.
 */
const STRUCTURED =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\] \[(trace|debug|info|warn|warning|error|critical|out)\] \[([A-Za-z0-9_.-]+)\] (?:\[([a-z][a-z0-9_]*)\] )?(?:(?:Debug|Info|Warning|Critical|Fatal): )?(.*)$/;

// --- signal patterns (verified match counts over the real corpus) -----------

/** 152 533 matches. Emitted by LogosAPIClient before every remote call. */
const CALL_STARTED = /LogosAPIClient: invoking remote method "([^"]+)" "([^"]+)" args_count: (\d+)/;

/**
 * 152 532 matches. Carries the per-call timeout, i.e. the bridge's reply window
 * for a synchronous call: learnCallWindow reads it so that every derived
 * deadline follows a Basecamp whose window was raised.
 */
const CALL_DISPATCHED =
  /LogosAPIConsumer: Calling invokeRemoteMethod: "([^"]+)" "([^"]+)" args_count: (\d+) timeout: (\d+)/;

/**
 * 153 414 matches. The last line emitted before the transport blocks on the
 * reply, and the ONLY place the failing method's name appears — the failure
 * line itself carries neither module nor method. pairFailures() walks back to
 * the nearest one of these.
 */
const TRANSPORT_CALL = /RemoteLogosObject::callMethod(Async)? "([^"]+)" args: (\d+)/;

/**
 * 936 matches. The async equivalent of CALL_STARTED, and the reason it is
 * needed: measured over the whole corpus, 936 async dispatches occur and NOT
 * ONE of them is preceded by an `invoking remote method` line. `logos.callModuleAsync`
 * is a first-class QML bridge API — medusa_ui alone uses it seven times — so
 * treating CALL_STARTED as "every dispatch" made `calls:` unpassable for those
 * calls and made `no_calls:` pass when the call had in fact been made.
 *
 * It carries no module. That comes from MODULE_CONTEXT below.
 */
const CALL_STARTED_ASYNC = /LogosAPIConsumer: async calling via LogosObject::callMethodAsync "([^"]+)"/;

/**
 * 170 433 + 8 519 matches. Which module the caller is about to talk to.
 *
 * Emitted while resolving the remote object, immediately before the async
 * dispatch: 931 of the 936 async dispatches have a getToken line within six
 * lines above them. Useless on its own; the only way to qualify an async call.
 */
const MODULE_CONTEXT =
  /(?:LogosAPIClient: getToken for module|RemoteTransportConnection: Requesting object): "?([^"\s]+)"?/;

/**
 * The transport's own failure line for a synchronous call. Three spellings:
 *
 *   callRemoteMethod failed or timed out: <code>   0.2.2, one line for both
 *   callRemoteMethod timed out                     0.3.0, the deadline elapsed
 *   callRemoteMethod failed: <code>                0.3.0, QtRO reported an error
 *
 * The code is QRemoteObjectPendingCall's error enum, which qDebug prints as an
 * integer, so it is captured as a token rather than as digits.
 */
const CALL_FAILED = /RemoteLogosObject: callRemoteMethod (?:failed or timed out: (\S+)|(timed out)|failed: (\S+))/;
const CALL_ASYNC_TIMEOUT = /RemoteLogosObject: async callMethod timed out/;

/**
 * The transport's other ways to give up on a call, identical on 0.2.2 and
 * 0.3.0. A deferred call is one issued before its replica was ready; its
 * timeout is the only line a 20 s failure of that kind ever prints.
 */
const TRANSPORT_FAIL_EXTRA =
  /RemoteLogosObject: (?:deferred call "?([^"\s]*)"? timed out|async callMethod error: (\S+)|Failed to invoke callRemoteMethod on replica|Cannot call method on null replica)/;

/**
 * The module's replica was never acquired, so the call was never dispatched.
 *
 * On 0.3.0 this is the common way a call to a module that is not up yet
 * fails: the bridge gives such a call a 1.5 s budget and the only line it
 * leaves is `Timeout waiting for replica`. 0.2.2, and 0.3.0 re-acquiring a
 * stale handle, also print `Failed to acquire plugin/replica`, which is the
 * same failure told twice. `RemoteTransportConnection: no listener at ...` is
 * NOT a failure: it is printed before a wait that can still succeed.
 */
const ACQUIRE_FAIL =
  /(?:RemoteTransportConnection: (?:Timeout waiting for replica|Failed to acquire replica for)|LogosAPIConsumer: Failed to acquire plugin\/replica for object): "?([^"\s]+)"?/;

/**
 * 0.3.0 holds an asynchronous call to a module that is not reachable yet,
 * rather than failing it. An EMPTY event name is a held call; a named one is
 * an event subscription waiting for the same thing, and is not a call at all.
 * The consumer warns once at 3 s (and again at 60 s) that it is still waiting;
 * the bridge's own deadline then answers the app with {"error":"timeout"} and
 * logs nothing, so the warning is the only evidence the call failed.
 */
const CALL_HELD = /LogosAPIConsumer: '"([^"]+)"::""' deferred pending the module becoming reachable/;
const CALL_UNREACHABLE = /LogosAPIConsumer: '"([^"]+)"::""' still not reachable after (\d+) ms/;

/**
 * The capability handshake's own dispatches. Every first call to a module
 * starts with one on 0.3.0 (each consumer has its own identity, so tokens are
 * minted lazily), and on 0.2.2 whenever a token is missing.
 */
const INTERNAL = /(?:LogosObject::callMethodAsync|RemoteLogosObject::callMethod(?:Async)?) "(?:requestModule|informModuleToken)"/;

/** A missing token. Logged on every lazy first contact, so it is context, not a denial. */
const NO_TOKEN = /LogosAPIClient: No token found for module: "?([^"\s]+)"?/;

/** The handshake came back empty: the capability module refused the pair. */
const REQUEST_MODULE_REFUSED = /LogosAPIClient: requestModule result for "?([^"\s]+)"? : ""\s*$/;
/** A provider refused a call's token. Its module is the host's, from the structured prefix. */
const PROVIDER_REJECTED = /ModuleProxy: rejecting unauthorized call to "([^"]+)"/;
/** 0.3.0: an identity with no credential is about to be refused. */
const IDENTITY_REFUSED =
  /LogosAPIClient: identity "?[^"\s]+"? has an isolated token store with no credential, so its requestModule handshake for "?([^"\s]+)"? will be refused/;

/**
 * A module published a typed event. Two spellings, both qDebug in the host:
 * `emitEvent: "name"` from the provider, and 0.3.0's ModuleProxy forwarding
 * it. The provider's "no listener set for" line is not an event, and the
 * protocol's own `__logos_call_complete__` is not the app's.
 */
const EVENT_EMITTED =
  /\[LogosProviderObject\] (?:emitEvent: (?!no listener set for)"?([^"\s]+)"?|ModuleProxy: forwarding event "((?!__logos_)[^"]+)" as Qt signal)/;
const EVENT_SUBSCRIBED = /RemoteLogosObject::onEvent subscribing to event: "?([^"\s]+)"?/;

/** 147 matches. */
const MODULE_LOADED = /^Module loaded: "?([^"\s]+)"?/;
/** 78 matches. */
const CORE_STARTED = /Logos Core started successfully/;

/** 52 / 9 / 42 matches. */
const UI_LOADED = /Successfully loaded UI module: "([^"]+)"/;
const UI_LOAD_FAILED = /Failed to load UI module "([^"]+)"\s*:?\s*"?([^"]*)"?/;
const UI_UNLOADED = /Successfully unloaded UI module: "([^"]+)"/;

/**
 * 4 / 3 / 2 matches. The three reasons an app actually fails to appear.
 *
 * All of them were unclassified, so the reason a developer's app did not open
 * sat in the buffer while the tool reported "did not open within 120s" and
 * advised raising a timeout that could not help. The compile failure carries
 * the QML compiler's own file:line:column text, which is the whole diagnosis.
 */
const UI_COMPILE_FAILED = /Failed to compile ui_qml view "([^"]+)"\s*:\s*"([\s\S]*)"?$/;
const CORE_DEP_FAILED = /Failed to load core dependency "([^"]+)" for "([^"]+)"/;
const UI_HOST_TIMEOUT = /Timeout waiting for ui-host ready signal for "([^"]+)"/;

/**
 * 0.3.0's dependency gate, in front of every UI module load
 * (app/UIPluginManager.cpp). 0.2.2 has no gate; it tries the load and fails
 * with CORE_DEP_FAILED instead.
 */
const UI_BLOCKED_BY_DEPS = /^UI module "([^"]+)" blocked by deps \(\s*"?(.*?)"?\s*\):/;
const UI_DEPS_NOT_READY = /^UI module "([^"]+)" deferred: dependency data not ready/;

/**
 * The QML bridge's warnings. 0.2.2 prefixes them `LogosQmlBridge:` or
 * `LogosQmlBridge::<method>:`; 0.3.0 logs them under the logos.qmlbridge
 * category, which Qt's default pattern prints as `logos.qmlbridge: `. Its one
 * qDebug ("subscribed to") is chatter, not a warning.
 */
const BRIDGE = /^(?:LogosQmlBridge(?:::\w+)?:|logos\.qmlbridge:) (?!subscribed to )(.*)$/;
const BRIDGE_CRASH = /^view module crashed "?([^"\s]+)"?/;
const BRIDGE_MISUSE = /^(?:callModule(?:Async)?: )?"?([^"\s]+)"? is a view module/;

/**
 * Basecamp's plugin sandbox refusing something an app asked for. 0.3.0 tags
 * each block with the plugin it came from; 0.2.2 does not say whose it was.
 * `Redirected ...` and `Sandbox configured ...` are bookkeeping, not blocks.
 */
const SANDBOX_BLOCK = /^logos\.basecamp\.sandbox: (Blocked .*?)(?: \[plugin=([^\]]+)\])?: /;

/**
 * Any QML engine diagnostic, error or warning. Covers both qrc: (Basecamp's
 * own QML) and file:// (an app's own). 967 of these are hard errors; a further
 * ~7 400 are warnings the engine emits with the same shape — missing image
 * assets, binding loops, anchors inside a Layout, `Cannot override FINAL
 * property`. Those are exactly the defects an app developer wants surfaced, so
 * we classify the whole family and split on the message.
 */
const QML_DIAGNOSTIC = /^((?:file:\/\/|qrc:)\S*?):(\d+)(?::(\d+))?: (.*)$/;
/** Leading token of a hard runtime error, e.g. "TypeError: x is not a function". */
const QML_ERROR_KIND = /^((?:Type|Reference|Syntax|Range|URI|Eval)Error|Error)(?::\s*(.*))?$/;

/** 265 matches. QML console.log lands here. */
const QML_CONSOLE = /^qml: (.*)$/;

export function parseLine(line: LogLine): ParsedLine {
  let message = line.text;
  let stamp: string | undefined;
  let level: LogLevel | undefined;
  let module: string | undefined;

  const structured = STRUCTURED.exec(message);
  if (structured) {
    stamp = structured[1];
    level = structured[2] as LogLevel;
    const logger = structured[3]!;
    const host = structured[4];
    if (host !== undefined && logger !== "logos") {
      // An older build's logger IS the module, so a lower-case bracket after
      // it belongs to the message, not to a second module name.
      module = logger;
      message = `[${host}] ${structured[5]!}`;
    } else {
      // "logos" is liblogos's default logger, which every process shares; it
      // names no module. The bracket after it, when there is one, does.
      module = host ?? (logger === "logos" ? undefined : logger);
      message = structured[5]!;
    }
  }

  const signal = detectSignal(message);
  // A provider's rejection names only the method; the host it ran in is the
  // module that refused it.
  if (signal?.kind === "auth_denied" && signal.target === undefined && module !== undefined) {
    signal.target = module;
  }
  const isError =
    level === "error" ||
    level === "critical" ||
    signal?.kind === "call_failed" ||
    signal?.kind === "ui_module_load_failed" ||
    signal?.kind === "ui_compile_failed" ||
    signal?.kind === "core_dependency_failed" ||
    signal?.kind === "ui_host_timeout" ||
    signal?.kind === "ui_module_blocked" ||
    signal?.kind === "auth_denied" ||
    signal?.kind === "bridge_misuse" ||
    signal?.kind === "view_module_crashed" ||
    signal?.kind === "qml_error";

  const out: ParsedLine = { line, message, isError };
  if (stamp !== undefined) out.stamp = stamp;
  if (level !== undefined) out.level = level;
  if (module !== undefined) out.module = module;
  if (signal !== undefined) out.signal = signal;
  return out;
}

function detectSignal(message: string): Signal | undefined {
  let m: RegExpExecArray | null;

  if ((m = CALL_STARTED.exec(message))) {
    return { kind: "call_started", target: m[1]!, method: m[2]!, argCount: Number(m[3]) };
  }
  if ((m = CALL_DISPATCHED.exec(message))) {
    return {
      kind: "call_dispatched",
      target: m[1]!,
      method: m[2]!,
      argCount: Number(m[3]),
      timeoutMs: Number(m[4]),
    };
  }
  if ((m = CALL_STARTED_ASYNC.exec(message))) {
    const sig: Signal = { kind: "call_started_async", method: m[1]! };
    if (INTERNAL.test(message)) sig.internal = true;
    return sig;
  }
  if ((m = TRANSPORT_CALL.exec(message))) {
    const sig: Signal = { kind: "transport_call", method: m[2]!, argCount: Number(m[3]), detail: m[1] ? "async" : "sync" };
    if (INTERNAL.test(message)) sig.internal = true;
    return sig;
  }
  if ((m = CALL_FAILED.exec(message))) {
    const detail =
      m[1] !== undefined ? `callRemoteMethod failed or timed out (code ${m[1]})`
      : m[2] !== undefined ? "callRemoteMethod timed out"
      : `callRemoteMethod failed (code ${m[3]})`;
    return { kind: "call_failed", detail, failure: "transport" };
  }
  if (CALL_ASYNC_TIMEOUT.test(message)) {
    return { kind: "call_failed", detail: "async callMethod timed out", failure: "transport" };
  }
  if ((m = TRANSPORT_FAIL_EXTRA.exec(message))) {
    if (m[1] !== undefined) {
      return { kind: "call_failed", detail: `deferred call ${m[1] || "(unnamed)"} timed out`, failure: "transport" };
    }
    if (m[2] !== undefined) {
      return { kind: "call_failed", detail: `async callMethod error (code ${m[2]})`, failure: "transport" };
    }
    if (m[0].endsWith("null replica")) {
      // Printed before the transport line, so there is no transport line of
      // its own to pair with: the dispatch that preceded it is the victim.
      return {
        kind: "call_failed",
        detail: "the replica is gone (module unloaded or transport dropped)",
        failure: "null-replica",
      };
    }
    return { kind: "call_failed", detail: "the replica did not accept callRemoteMethod", failure: "transport" };
  }
  if ((m = ACQUIRE_FAIL.exec(message))) {
    return {
      kind: "call_failed",
      target: m[1]!,
      detail: `module ${m[1]} not reachable: replica not acquired`,
      failure: "acquire",
    };
  }
  if ((m = CALL_UNREACHABLE.exec(message))) {
    return {
      kind: "call_failed",
      target: m[1]!,
      detail: `module ${m[1]} not reachable after ${m[2]} ms; call held, not dispatched`,
      failure: "unreachable",
      elapsedMs: Number(m[2]),
    };
  }
  if ((m = CALL_HELD.exec(message))) {
    return { kind: "call_held", target: m[1]!, method: "?" };
  }
  if ((m = REQUEST_MODULE_REFUSED.exec(message))) {
    return { kind: "auth_denied", target: m[1]!, detail: "requestModule returned no token" };
  }
  if ((m = PROVIDER_REJECTED.exec(message))) {
    // The target is filled in from the structured prefix by parseLine.
    return { kind: "auth_denied", method: m[1]!, detail: "the provider rejected the call's token" };
  }
  if ((m = IDENTITY_REFUSED.exec(message))) {
    return { kind: "auth_denied", target: m[1]!, detail: "this identity has no credential" };
  }
  // Before MODULE_CONTEXT, which it does not match: it is context all the
  // same, and the handshake that follows is aimed at this module.
  if ((m = NO_TOKEN.exec(message))) {
    return { kind: "module_context", target: m[1]!, detail: "no token" };
  }
  if ((m = MODULE_CONTEXT.exec(message))) {
    return { kind: "module_context", target: m[1]! };
  }
  if ((m = EVENT_EMITTED.exec(message))) {
    return { kind: "event_emitted", method: (m[1] ?? m[2])! };
  }
  if ((m = EVENT_SUBSCRIBED.exec(message))) {
    return { kind: "event_subscribed", method: m[1]! };
  }
  if ((m = UI_LOADED.exec(message))) {
    return { kind: "ui_module_loaded", target: m[1]! };
  }
  // Before UI_LOAD_FAILED: the umbrella line has the same prefix shape, and
  // the specific reason is far more useful than "it failed".
  if ((m = UI_COMPILE_FAILED.exec(message))) {
    const sig: Signal = { kind: "ui_compile_failed", target: m[1]! };
    const detail = (m[2] ?? "").replace(/\\n/g, "\n").replace(/"\s*$/, "").trim();
    if (detail) sig.detail = detail;
    const loc = /((?:file:\/\/|qrc:)\S*?):(\d+)(?::(\d+))?:/.exec(detail);
    if (loc) {
      sig.file = loc[1]!;
      sig.lineNo = Number(loc[2]);
    }
    return sig;
  }
  if ((m = CORE_DEP_FAILED.exec(message))) {
    return { kind: "core_dependency_failed", target: m[2]!, detail: m[1]! };
  }
  if ((m = UI_HOST_TIMEOUT.exec(message))) {
    return { kind: "ui_host_timeout", target: m[1]! };
  }
  if ((m = UI_BLOCKED_BY_DEPS.exec(message))) {
    const sig: Signal = { kind: "ui_module_blocked", target: m[1]! };
    if (m[2]) sig.detail = m[2];
    return sig;
  }
  if ((m = UI_DEPS_NOT_READY.exec(message))) {
    return { kind: "ui_module_deferred", target: m[1]! };
  }
  if ((m = UI_LOAD_FAILED.exec(message))) {
    const sig: Signal = { kind: "ui_module_load_failed", target: m[1]! };
    if (m[2]) sig.detail = m[2];
    return sig;
  }
  if ((m = UI_UNLOADED.exec(message))) {
    return { kind: "ui_module_unloaded", target: m[1]! };
  }
  if ((m = MODULE_LOADED.exec(message))) {
    return { kind: "module_loaded", target: m[1]! };
  }
  if (CORE_STARTED.test(message)) {
    return { kind: "core_started" };
  }
  if ((m = QML_DIAGNOSTIC.exec(message))) {
    const file = m[1]!;
    const lineNo = Number(m[2]);
    const rest = m[4]!;
    const err = QML_ERROR_KIND.exec(rest);
    if (err) {
      const sig: Signal = { kind: "qml_error", file, lineNo, errorType: err[1]! };
      if (err[2]) sig.detail = err[2];
      return sig;
    }
    return { kind: "qml_warning", file, lineNo, detail: rest };
  }
  if ((m = QML_CONSOLE.exec(message))) {
    return { kind: "qml_console", detail: m[1]! };
  }
  if ((m = BRIDGE.exec(message))) {
    const rest = m[1]!;
    let b: RegExpExecArray | null;
    if ((b = BRIDGE_CRASH.exec(rest))) return { kind: "view_module_crashed", target: b[1]!, detail: rest };
    if ((b = BRIDGE_MISUSE.exec(rest))) {
      return { kind: "bridge_misuse", target: b[1]!, detail: `${b[1]} is a view module; call it through logos.module()` };
    }
    return { kind: "bridge_warning", detail: rest };
  }
  if ((m = SANDBOX_BLOCK.exec(message))) {
    // A QML diagnostic in all but shape: something the app's QML asked for was
    // refused. Counted by `no_warnings:` against the app it names.
    const sig: Signal = { kind: "qml_warning", detail: m[1]! };
    if (m[2]) sig.target = m[2];
    return sig;
  }
  return undefined;
}

/**
 * The bridge's reply window, as the log has shown it: the largest `timeout: N`
 * on a synchronous dispatch line among `lines`, or null when none carries one.
 *
 * logos-protocol prints the Timeout it was handed on every synchronous
 * dispatch (`LogosAPIConsumer: Calling invokeRemoteMethod: ... timeout: 20000`),
 * so this is the window actually in force rather than one assumed from a
 * source revision. Asynchronous dispatches print none; a window raised only for
 * those has to be declared with `call_timeout:` or --call-timeout.
 */
export function learnCallWindow(lines: Iterable<LogLine>): number | null {
  let most: number | null = null;
  for (const line of lines) {
    // Cheap test first: this runs over every line a step adds.
    if (!line.text.includes("timeout: ")) continue;
    const ms = parseLine(line).signal;
    if (ms?.kind !== "call_dispatched" || ms.timeoutMs === undefined || !(ms.timeoutMs > 0)) continue;
    if (most === null || ms.timeoutMs > most) most = ms.timeoutMs;
  }
  return most;
}

/**
 * learnCallWindow over a growing log, reading each line once.
 *
 * A run asks at every step; rescanning a chatty app's whole log each time
 * would cost more than the step.
 */
export class CallWindowTracker {
  private seen: number | null = null;
  private next: LogCursor = 0;

  /** The largest window seen so far, having read whatever arrived since the last call. */
  observe(logs: { slice(from: LogCursor): LogLine[] }): number | null {
    const fresh = logs.slice(this.next);
    const last = fresh[fresh.length - 1];
    if (last) {
      this.next = last.seq + 1;
      const w = learnCallWindow(fresh);
      if (w !== null && (this.seen === null || w > this.seen)) this.seen = w;
    }
    return this.seen;
  }
}

/**
 * Which app a line belongs to, so a developer sees only their own failures.
 *
 * Attribution sources, in order of confidence:
 *   * a structured prefix names the emitting module outright;
 *   * a QML error's file:// path contains .../plugins/<name>/...;
 *   * a call_* signal names the callee module.
 * Basecamp's own QML lives under qrc:, which is how we tell house noise from
 * an app's genuine breakage.
 */
export function attributeTo(parsed: ParsedLine): string | undefined {
  if (parsed.module) return parsed.module;
  const file = parsed.signal?.file;
  if (file) {
    const m = /\/plugins\/([^/]+)\//.exec(file);
    if (m) return m[1]!;
    if (file.startsWith("qrc:")) return "basecamp";
  }
  if (parsed.signal?.target) return parsed.signal.target;
  return undefined;
}

/** One backend call observed in a window, however it was dispatched. */
export interface ObservedCall {
  /** Callee module. Undefined only when an async call's context was not in the window. */
  module?: string;
  method: string;
  async: boolean;
  /** Sequence number of the line that evidenced it. */
  seq: number;
  /**
   * True for a call Basecamp 0.3.0 HELD because its module was not reachable,
   * and that was never dispatched in the window. The app asked for it; it did
   * not happen. Its method is "?": the held line names only the module.
   */
  held?: boolean;
}

/**
 * Every backend call in a window, synchronous and asynchronous alike.
 *
 * A synchronous dispatch names its own module. An asynchronous one does not —
 * `LogosAPIConsumer: async calling via LogosObject::callMethodAsync "<method>"`
 * carries the method only — so it is qualified from the nearest preceding
 * module_context line. Measured: 931 of 936 async dispatches have one within
 * six lines. Where none is found the call is still reported, with the module
 * left undefined, because dropping it is what made `no_calls:` lie.
 *
 * Two 0.3.0 shapes are folded in:
 *
 *   * The capability handshake's own dispatch (requestModule) is the
 *     protocol's, not the app's, so it is skipped, and the context goes back
 *     to the module the handshake was for: the one that had no token.
 *   * A call held for a module that is not reachable is reported as `X.?`,
 *     held, unless an async dispatch to X later in the window shows it went
 *     through. Dropping it would make `no_calls:` pass on a call the app made.
 */
export function callsIn(parsed: ParsedLine[]): ObservedCall[] {
  const out: ObservedCall[] = [];
  let context: string | undefined;
  /** The module the latest handshake was for. */
  let handshakeFor: string | undefined;
  /** Held calls not yet dispatched, per module, oldest first. */
  const pendingHeld = new Map<string, ObservedCall[]>();
  const consumed = new Set<ObservedCall>();
  for (const p of parsed) {
    const sig = p.signal;
    if (!sig) continue;
    if (sig.kind === "module_context") {
      context = sig.target;
      if (sig.detail === "no token") handshakeFor = sig.target;
    } else if (sig.kind === "call_started") {
      // A synchronous call names its own callee; it also refreshes the context,
      // since the next async dispatch is likely aimed at the same module.
      context = sig.target;
      out.push({ module: sig.target!, method: sig.method!, async: false, seq: p.line.seq });
    } else if (sig.kind === "call_started_async") {
      if (sig.internal) {
        if (handshakeFor !== undefined) context = handshakeFor;
        continue;
      }
      const call: ObservedCall = { method: sig.method!, async: true, seq: p.line.seq };
      if (context !== undefined) {
        call.module = context;
        const waiting = pendingHeld.get(context);
        const first = waiting?.shift();
        if (first) consumed.add(first);
      }
      out.push(call);
    } else if (sig.kind === "call_held") {
      const call: ObservedCall = { module: sig.target!, method: "?", async: true, seq: p.line.seq, held: true };
      const waiting = pendingHeld.get(sig.target!) ?? [];
      waiting.push(call);
      pendingHeld.set(sig.target!, waiting);
      out.push(call);
    }
  }
  return consumed.size === 0 ? out : out.filter((c) => !consumed.has(c));
}

/** "module.method", or "?.method" when an async call's module was not recoverable. */
export function callName(c: ObservedCall): string {
  return `${c.module ?? "?"}.${c.method}`;
}

/** callName, plus what a held call means, for a report a person reads. */
export function describeCall(c: ObservedCall): string {
  return c.held ? `${callName(c)} (held: module not reachable)` : callName(c);
}

/**
 * Why an app did not open, taken from what the log already said.
 *
 * Returns null when the log offers no explanation — which is the only case
 * where "it timed out, try raising --timeout" is honest advice.
 */
export function explainOpenFailure(window: ParsedLine[], appName: string): string | null {
  let deferred = false;
  for (const p of window) {
    const sig = p.signal;
    if (!sig || sig.target !== appName) continue;
    if (sig.kind === "ui_compile_failed") {
      const where = sig.file ? `${sig.file}:${sig.lineNo ?? "?"}` : "its QML";
      return `${appName}'s QML did not compile — ${where}\n${(sig.detail ?? "").split("\n").map((l) => "  " + l).join("\n")}`;
    }
    if (sig.kind === "core_dependency_failed") {
      return (
        `${appName} declares the core module "${sig.detail}", and Basecamp could not load it. ` +
        `Stage it with --with ${sig.detail}, or check that it is built.`
      );
    }
    if (sig.kind === "ui_module_blocked") {
      return (
        `Basecamp refused to open ${appName} because of a missing or mismatched dependency` +
        `${sig.detail ? ` (${sig.detail})` : ""}, and showed a popup instead of the app. ` +
        `Stage the dependency with --with <name>, at a version the manifest accepts.`
      );
    }
    if (sig.kind === "ui_host_timeout") {
      return (
        `${appName}'s ui-host process never signalled ready. That is the out-of-process host for a ` +
        `non-pure-QML plugin; check its plugin .so loads and that its dependencies are present.`
      );
    }
    if (sig.kind === "ui_module_load_failed") {
      return `Basecamp declined to load ${appName}: ${sig.detail ?? "no reason given"}`;
    }
    if (sig.kind === "ui_module_deferred") deferred = true;
    // A load that followed the deferral means the gate opened after all.
    if (sig.kind === "ui_module_loaded") deferred = false;
  }
  if (deferred) {
    return (
      `Basecamp parked ${appName}'s load until its launcher's dependency data arrived, and it never did ` +
      `("UI module ${JSON.stringify(appName)} deferred: dependency data not ready"). That data comes from ` +
      `package_manager; a module it waits on that is slow or missing is the usual cause.`
    );
  }
  return null;
}

/** True for QML errors raised inside Basecamp's own embedded QML (qrc:). */
export function isBasecampInternalNoise(parsed: ParsedLine): boolean {
  return parsed.signal?.kind === "qml_error" && (parsed.signal.file ?? "").startsWith("qrc:");
}

/** The method name given to a failure no dispatch could be matched to. */
export const UNATTRIBUTED = "(unknown)";

export interface PairedFailure {
  /** Best guess at the method that failed. "?" when only the module is known. */
  method: string;
  module?: string;
  /**
   * False when other calls were in flight nearby, so the anchor may belong to
   * a different one. The pairing is positional — there is no correlation id —
   * and saying "getWalletState failed" when three calls were racing would be a
   * confident guess dressed as a fact.
   */
  confident: boolean;
  /** The other methods dispatched close enough to be the real victim. */
  alternatives: string[];
  /**
   * Sequence number of the dispatch this was matched to, when there was one.
   *
   * A transport reply times out after the bridge's reply window (20 s on stock
   * Basecamp, read from the log when it says otherwise), and a crawl observes
   * each click for 2.5 s, so a timeout NEVER lands in the window of the click
   * that caused it.
   * Knowing where the dispatch was is what lets a caller charge the failure to
   * the click that made it instead of to whichever one happened to be running
   * when the timeout fired.
   */
  anchorSeq?: number;
  /**
   * How it failed, when the log says more than "failed or timed out": a
   * module that was never reachable, or a failure inside the token handshake
   * that precedes a first call.
   */
  detail?: string;
}

/**
 * Recover the method name for each failure.
 *
 * `RemoteLogosObject: callRemoteMethod failed or timed out: <n>` (0.2.2), and
 * 0.3.0's `callRemoteMethod timed out` / `failed: <n>`, name neither the
 * module nor the method, so on its own a failure is unattributable. The
 * transport emits `RemoteLogosObject::callMethod "<method>" args: N`
 * immediately before blocking on the reply, so the nearest preceding
 * transport_call identifies the victim.
 *
 * That is positional, not an id. A UI that polls — medusa_ui asks for
 * pendingRequests every 800 ms — has calls overlapping constantly, so we also
 * report whether anything else was dispatched in the immediate run-up and,
 * if so, hand back the alternatives rather than pretending to certainty.
 *
 * Three failures are not transport replies and are paired differently:
 *
 *   * a replica that was never acquired names its module; it is matched to
 *     the latest call to that module and leaves the transport lines alone,
 *     and the same failure told twice (0.2.2 prints two lines) counts once;
 *   * a held call still not reachable is matched to the line that held it,
 *     and is dropped if a dispatch to that module followed, since then the
 *     call went through after all;
 *   * a null replica is refused before any transport line is printed, so it
 *     is matched to the latest dispatch instead.
 *
 * The capability handshake's own dispatches stay anchors, so a handshake that
 * times out is still caught, but they are never offered as alternatives, and a
 * failure anchored to one is reported against the call the handshake was for.
 */
export function pairFailures(parsed: ParsedLine[]): Map<number, PairedFailure> {
  const out = new Map<number, PairedFailure>();
  /** Methods dispatched recently, newest last. */
  // The module is captured WITH each dispatch. Reading a single `lastModule` at
  // the failure line stamped whichever module most recently asked for a token —
  // 178 952 of those lines in the corpus, most from calls that never
  // dispatched — so the evidence named a module that had not failed, and
  // `suppressedBy` then keyed on that wrong name: an unrelated ignore entry
  // silenced a real timeout, and the author's correct entry stopped working.
  const recent: Array<{ method: string; seq: number; module?: string; internal?: boolean; forCall?: { module: string; method: string } }> = [];
  let lastModule: string | undefined;
  /** Calls the app made, synchronous (call_started / call_dispatched), newest last. */
  const userCalls: Array<{ module: string; method: string; seq: number }> = [];
  /** The latest line naming each module, for a failure that names only the module. */
  const lastContext = new Map<string, number>();
  /** Every dispatch of any kind, newest last, for a failure that precedes its transport line. */
  let lastDispatch: { method: string; seq: number; module?: string } | undefined;
  /** The module the latest handshake was for (the one that had no token). */
  let handshakeFor: string | undefined;
  /** Held calls per module, oldest first; `dispatched` once a dispatch to it followed. */
  const held = new Map<string, Array<{ seq: number; dispatched: boolean; reportedAt?: number }>>();
  /** Counts call signals, so a failure told twice with nothing between is told once. */
  let callSignals = 0;
  const lastAcquire = new Map<string, number>();

  for (const p of parsed) {
    const sig = p.signal;
    const kind = sig?.kind;
    if (kind === "call_started" || kind === "call_dispatched") {
      lastModule = sig!.target;
      callSignals++;
      userCalls.push({ module: sig!.target!, method: sig!.method!, seq: p.line.seq });
      if (userCalls.length > USER_LOOKBACK) userCalls.shift();
      lastContext.set(sig!.target!, p.line.seq);
      lastDispatch = { method: sig!.method!, seq: p.line.seq, module: sig!.target! };
    } else if (kind === "module_context") {
      // module_context matters: an asynchronous dispatch carries only a method
      // name, so without it every async call paired as "?.method". Combined
      // with matchesCall's "?" widening, a qualified ignore entry for ANOTHER
      // module then matched it — ignore_calls: ["medusa_core.getJob"] silenced
      // their_core.getJob's timeout, a false PASS. The module is right here in
      // the log; not reading it was the whole bug.
      lastModule = sig!.target;
      lastContext.set(sig!.target!, p.line.seq);
      if (sig!.detail === "no token") handshakeFor = sig!.target;
    } else if (kind === "call_started_async") {
      callSignals++;
      if (!sig!.internal) {
        lastDispatch = { method: sig!.method!, seq: p.line.seq, ...(lastModule ? { module: lastModule } : {}) };
        const waiting = lastModule !== undefined ? held.get(lastModule) : undefined;
        const first = waiting?.find((h) => !h.dispatched);
        if (first) first.dispatched = true;
      }
    } else if (kind === "call_held") {
      callSignals++;
      const list = held.get(sig!.target!) ?? [];
      list.push({ seq: p.line.seq, dispatched: false });
      held.set(sig!.target!, list);
      lastContext.set(sig!.target!, p.line.seq);
    } else if (kind === "transport_call") {
      callSignals++;
      const entry: (typeof recent)[number] = { method: sig!.method!, seq: p.line.seq, ...(lastModule ? { module: lastModule } : {}) };
      if (sig!.internal) {
        entry.internal = true;
        // The call the handshake is for: the pending synchronous call to that
        // module when there is one, else the module alone (an async call
        // prints nothing until it is dispatched).
        if (handshakeFor !== undefined) {
          const pending = userCalls.at(-1);
          entry.forCall = pending && pending.module === handshakeFor ? pending : { module: handshakeFor, method: "?" };
          // Back to the module the handshake was for, as the dispatch that
          // follows it is aimed there.
          lastModule = handshakeFor;
        }
      } else {
        lastDispatch = { method: entry.method, seq: entry.seq, ...(entry.module ? { module: entry.module } : {}) };
      }
      recent.push(entry);
      if (recent.length > LOOKBACK) recent.shift();
    } else if (kind === "call_failed") {
      const failure = sig!.failure ?? "transport";
      if (failure === "acquire") {
        const x = sig!.target!;
        // `Timeout waiting for replica` then `Failed to acquire plugin/replica`
        // is one failure told twice.
        if (lastAcquire.get(x) === callSignals) continue;
        lastAcquire.set(x, callSignals);
        const forX = userCalls.filter((c) => c.module === x);
        const anchor = forX.at(-1);
        if (anchor) {
          const alternatives = [...new Set(forX.map((c) => c.method))].filter((m) => m !== anchor.method);
          out.set(p.line.seq, {
            method: anchor.method,
            module: x,
            confident: alternatives.length === 0,
            alternatives,
            anchorSeq: anchor.seq,
            detail: sig!.detail!,
          });
        } else if (lastContext.has(x)) {
          // An async call to a module that was never reached prints only the
          // module it was aimed at.
          out.set(p.line.seq, {
            method: "?",
            module: x,
            confident: true,
            alternatives: [],
            anchorSeq: lastContext.get(x)!,
            detail: sig!.detail!,
          });
        } else {
          out.set(p.line.seq, { method: UNATTRIBUTED, module: x, confident: false, alternatives: [], detail: sig!.detail! });
        }
        continue;
      }
      if (failure === "unreachable") {
        // The consumer repeats its warning at 60 s; the first one was the failure.
        if ((sig!.elapsedMs ?? 0) >= 60_000) continue;
        const x = sig!.target!;
        const list = held.get(x);
        const entry = list?.find((h) => !h.dispatched && h.reportedAt === undefined);
        if (entry) {
          entry.reportedAt = p.line.seq;
          out.set(p.line.seq, {
            method: "?",
            module: x,
            confident: true,
            alternatives: [],
            anchorSeq: entry.seq,
            detail: sig!.detail!,
          });
        } else if (!list || list.length === 0) {
          // Held before this window began: real, but not this window's.
          out.set(p.line.seq, { method: UNATTRIBUTED, module: x, confident: false, alternatives: [], detail: sig!.detail! });
        }
        continue;
      }
      if (failure === "null-replica") {
        if (!lastDispatch) {
          out.set(p.line.seq, { method: UNATTRIBUTED, confident: false, alternatives: [], detail: sig!.detail! });
          continue;
        }
        const entry: PairedFailure = {
          method: lastDispatch.method,
          confident: true,
          alternatives: [],
          anchorSeq: lastDispatch.seq,
          detail: sig!.detail!,
        };
        if (lastDispatch.module) entry.module = lastDispatch.module;
        out.set(p.line.seq, entry);
        continue;
      }
      const anchor = recent.pop();
      if (anchor === undefined) {
        // No anchor in this window. It used to be dropped, which is how a burst
        // of 22 real transport failures reported as one: the first consumed the
        // anchor list and the other 21 vanished, leaving a step green. An
        // unattributable failure is still a failure.
        out.set(p.line.seq, { method: UNATTRIBUTED, confident: false, alternatives: [] });
        continue;
      }
      // The handshake's own dispatches are never the app's calls, so never
      // candidates. (Alternatives stay bare method names: they are candidates,
      // and the report says so. Qualifying them with the anchor's module would
      // assert a pairing that does not exist.)
      const victim = anchor.internal && anchor.forCall ? anchor.forCall : anchor;
      const alternatives = [...new Set(recent.filter((r) => !r.internal).map((r) => r.method))].filter(
        (m) => m !== victim.method,
      );
      const entry: PairedFailure = {
        method: victim.method,
        confident: alternatives.length === 0,
        alternatives,
        anchorSeq: anchor.seq,
      };
      if (victim.module) entry.module = victim.module;
      if (anchor.internal) entry.detail = "during token exchange";
      out.set(p.line.seq, entry);
    }
  }
  // A held call that was dispatched after its warning went through in the end.
  for (const list of held.values()) {
    for (const h of list) if (h.dispatched && h.reportedAt !== undefined) out.delete(h.reportedAt);
  }
  return out;
}

/** How many recent dispatches count as "could plausibly be the one that failed". */
const LOOKBACK = 4;
/** How many of the app's recent calls an acquire failure is matched against. */
const USER_LOOKBACK = 16;
