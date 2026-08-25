// ---------------------------------------------------------------------------
// Turning Basecamp log lines into semantic signals.
//
// Two line shapes reach the stream:
//
//   1. Plain Qt output from the Basecamp process itself
//        LogosAPIClient: invoking remote method "medusa_core" "getWalletState" args_count: 0
//   2. Structured output from a module host process, whose stdout is inherited
//      from Basecamp and therefore lands in the same pipe
//        [2026-08-04 18:14:09.123] [info] [package_manager] [LogosProviderObject] ...
//
// A structured line's message can itself be a plain signal, so we strip the
// prefix first and classify the remainder. That is how a call made *by a
// module* is caught as well as one made by the UI.
//
// Every pattern below was counted against the real log corpus in
// ~/.local/share/Logos/LogosBasecampDev/logs (match counts in comments) rather
// than written from imagination.
// ---------------------------------------------------------------------------

import type { LogLine } from "./buffer.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "warning" | "error" | "critical";

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
  /** Capability check refused a module pair — calls will fail after this. */
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

const STRUCTURED =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\] \[(trace|debug|info|warn|warning|error|critical)\] \[([A-Za-z0-9_]+)\] (.*)$/;

// --- signal patterns (verified match counts over the real corpus) -----------

/** 152 533 matches. Emitted by LogosAPIClient before every remote call. */
const CALL_STARTED = /LogosAPIClient: invoking remote method "([^"]+)" "([^"]+)" args_count: (\d+)/;

/** 152 532 matches. Carries the per-call timeout we use to bound the wait. */
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

/** 57 + 10 matches. The only failure evidence the transport produces. */
const CALL_FAILED = /RemoteLogosObject: callRemoteMethod failed or timed out: (\d+)/;
const CALL_ASYNC_TIMEOUT = /RemoteLogosObject: async callMethod timed out/;

/** 2 matches. A missing capability token; every later call to that module dies. */
const AUTH_DENIED = /LogosAPIClient: No token found for module: "?([^"\s]+)"?/;

/** 8 matches each. */
const EVENT_EMITTED = /\[LogosProviderObject\] emitEvent: "?([^"\s]+)"?/;
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
    module = structured[3];
    message = structured[4]!;
  }

  const signal = detectSignal(message);
  const isError =
    level === "error" ||
    level === "critical" ||
    signal?.kind === "call_failed" ||
    signal?.kind === "ui_module_load_failed" ||
    signal?.kind === "ui_compile_failed" ||
    signal?.kind === "core_dependency_failed" ||
    signal?.kind === "ui_host_timeout" ||
    signal?.kind === "auth_denied" ||
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
    return { kind: "call_started_async", method: m[1]! };
  }
  if ((m = TRANSPORT_CALL.exec(message))) {
    return { kind: "transport_call", method: m[2]!, argCount: Number(m[3]), detail: m[1] ? "async" : "sync" };
  }
  if ((m = CALL_FAILED.exec(message))) {
    return { kind: "call_failed", detail: `callRemoteMethod failed or timed out (code ${m[1]})` };
  }
  if (CALL_ASYNC_TIMEOUT.test(message)) {
    return { kind: "call_failed", detail: "async callMethod timed out" };
  }
  // After AUTH_DENIED would be wrong: "No token found for module" must stay a
  // denial, and it does not match MODULE_CONTEXT, but order is load-bearing
  // enough here to be worth stating.
  if ((m = AUTH_DENIED.exec(message))) {
    return { kind: "auth_denied", target: m[1]! };
  }
  if ((m = MODULE_CONTEXT.exec(message))) {
    return { kind: "module_context", target: m[1]! };
  }
  if ((m = EVENT_EMITTED.exec(message))) {
    return { kind: "event_emitted", method: m[1]! };
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
  return undefined;
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
 */
export function callsIn(parsed: ParsedLine[]): ObservedCall[] {
  const out: ObservedCall[] = [];
  let context: string | undefined;
  for (const p of parsed) {
    const sig = p.signal;
    if (!sig) continue;
    if (sig.kind === "module_context") {
      context = sig.target;
    } else if (sig.kind === "call_started") {
      // A synchronous call names its own callee; it also refreshes the context,
      // since the next async dispatch is likely aimed at the same module.
      context = sig.target;
      out.push({ module: sig.target!, method: sig.method!, async: false, seq: p.line.seq });
    } else if (sig.kind === "call_started_async") {
      const call: ObservedCall = { method: sig.method!, async: true, seq: p.line.seq };
      if (context !== undefined) call.module = context;
      out.push(call);
    }
  }
  return out;
}

/** "module.method", or "?.method" when an async call's module was not recoverable. */
export function callName(c: ObservedCall): string {
  return `${c.module ?? "?"}.${c.method}`;
}

/**
 * Why an app did not open, taken from what the log already said.
 *
 * Returns null when the log offers no explanation — which is the only case
 * where "it timed out, try raising --timeout" is honest advice.
 */
export function explainOpenFailure(window: ParsedLine[], appName: string): string | null {
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
    if (sig.kind === "ui_host_timeout") {
      return (
        `${appName}'s ui-host process never signalled ready. That is the out-of-process host for a ` +
        `non-pure-QML plugin; check its plugin .so loads and that its dependencies are present.`
      );
    }
    if (sig.kind === "ui_module_load_failed") {
      return `Basecamp declined to load ${appName}: ${sig.detail ?? "no reason given"}`;
    }
  }
  return null;
}

/** True for QML errors raised inside Basecamp's own embedded QML (qrc:). */
export function isBasecampInternalNoise(parsed: ParsedLine): boolean {
  return parsed.signal?.kind === "qml_error" && (parsed.signal.file ?? "").startsWith("qrc:");
}


/**
 * Recover the method name for each failure.
 *
 * `RemoteLogosObject: callRemoteMethod failed or timed out: <n>` names neither
 * the module nor the method, so on its own a failure is unattributable. The
 * transport emits `RemoteLogosObject::callMethod "<method>" args: N`
 * immediately before blocking on the reply, so the nearest preceding
 * transport_call identifies the victim. Verified against the corpus: every one
 * of the 57 failures had such an anchor within two lines.
 *
 * This is positional, not an id — concurrent calls in flight can mis-attribute.
 * The runner treats a paired failure as evidence, never as proof, and says so.
 */
/** The method name given to a failure no dispatch could be matched to. */
export const UNATTRIBUTED = "(unknown)";

export interface PairedFailure {
  /** Best guess at the method that failed. */
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
   * A transport reply times out after 20 s, and a crawl observes each click for
   * 2.5 s, so a timeout NEVER lands in the window of the click that caused it.
   * Knowing where the dispatch was is what lets a caller charge the failure to
   * the click that made it instead of to whichever one happened to be running
   * when the timeout fired.
   */
  anchorSeq?: number;
}

/**
 * Recover the method name for each failure.
 *
 * `RemoteLogosObject: callRemoteMethod failed or timed out: <n>` names neither
 * the module nor the method, so on its own a failure is unattributable. The
 * transport emits `RemoteLogosObject::callMethod "<method>" args: N`
 * immediately before blocking on the reply, so the nearest preceding
 * transport_call identifies the victim.
 *
 * That is positional, not an id. A UI that polls — medusa_ui asks for
 * pendingRequests every 800 ms — has calls overlapping constantly, so we also
 * report whether anything else was dispatched in the immediate run-up and,
 * if so, hand back the alternatives rather than pretending to certainty.
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
  const recent: Array<{ method: string; seq: number; module?: string }> = [];
  let lastModule: string | undefined;

  for (const p of parsed) {
    const kind = p.signal?.kind;
    if (kind === "call_started" || kind === "call_dispatched" || kind === "module_context") {
      // module_context matters: an asynchronous dispatch carries only a method
      // name, so without it every async call paired as "?.method". Combined
      // with matchesCall's "?" widening, a qualified ignore entry for ANOTHER
      // module then matched it — ignore_calls: ["medusa_core.getJob"] silenced
      // their_core.getJob's timeout, a false PASS. The module is right here in
      // the log; not reading it was the whole bug.
      lastModule = p.signal!.target;
    } else if (kind === "transport_call") {
      recent.push({ method: p.signal!.method!, seq: p.line.seq, ...(lastModule ? { module: lastModule } : {}) });
      if (recent.length > LOOKBACK) recent.shift();
    } else if (kind === "call_failed") {
      const anchor = recent.pop();
      if (anchor === undefined) {
        // No anchor in this window. It used to be dropped, which is how a burst
        // of 22 real transport failures reported as one: the first consumed the
        // anchor list and the other 21 vanished, leaving a step green. An
        // unattributable failure is still a failure.
        out.set(p.line.seq, { method: UNATTRIBUTED, confident: false, alternatives: [] });
        continue;
      }
      const alternatives = [...new Set(recent.map((r) => r.method))].filter((m) => m !== anchor.method);
      // (Alternatives stay bare method names: they are candidates, and the
      // report says so. Qualifying them with the anchor's module would assert
      // a pairing that does not exist.)
      const entry: PairedFailure = {
        method: anchor.method,
        confident: alternatives.length === 0,
        alternatives,
        anchorSeq: anchor.seq,
      };
      if (anchor.module) entry.module = anchor.module;
      out.set(p.line.seq, entry);
    }
  }
  return out;
}

/** How many recent dispatches count as "could plausibly be the one that failed". */
const LOOKBACK = 4;
