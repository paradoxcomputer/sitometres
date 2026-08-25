// ---------------------------------------------------------------------------
// Wire types for the Logos QML inspector.
//
// Ground truth: the inspectorserver.cpp actually linked into the running
// binary. Beware: several revisions coexist in /nix/store and they differ
// behaviourally. Verify with `strings -a <binary> | grep -cx listFileDialogs`
// — the 14-command revision answers 1, the older 12-command one answers 0.
// This client is written against the union and feature-detects at connect.
//
// The server speaks
// newline-delimited JSON over TCP (default localhost:3768, overridable with
// QML_INSPECTOR_PORT).
//
//   request   {"id": <int>, "command": <string>, "params": {...}}\n
//   success   {"ok": true,  ...data, "id": <int>}\n
//   failure   {"error": "<message>",  "id": <int>}\n
//
// Note there is no "ok": false on the failure path — a response is an error iff
// it carries an `error` key. `id` is echoed only when the request supplied one
// >= 0, so we always send one.
//
// Every command is dispatched synchronously from the socket's readyRead slot,
// i.e. on the Qt GUI thread, inline and unqueued. Consequences:
//
//   * commands never interleave, so responses arrive in request order, and a
//     slow command blocks the UI and every other client;
//   * `click` posts its QMouseEvents with QApplication::postEvent, which is
//     ASYNCHRONOUS. The reply says only that two events were enqueued — not
//     that anything handled them, and not that any handler has run yet.
//     (`sendKeys` still uses the blocking sendEvent.)
//
// That second point is the whole reason sitometres exists: a green
// findAndClick is not evidence of anything. Proof has to come from what the
// app does afterwards, which is what the log correlation in ../logs supplies.
// ---------------------------------------------------------------------------

/** Every command the inspector server implements. */
export const INSPECTOR_COMMANDS = [
  "getTree",
  "getProperties",
  "setProperty",
  "callMethod",
  "findByType",
  "findByProperty",
  "screenshot",
  "click",
  "sendKeys",
  "evaluate",
  "findAndClick",
  "listInteractive",
  // Present only in the 14-command revision; guarded by feature detection.
  "listFileDialogs",
  "fileDialogAction",
] as const;

export type InspectorCommand = (typeof INSPECTOR_COMMANDS)[number];

export interface InspectorRequest {
  id: number;
  command: InspectorCommand;
  params: Record<string, unknown>;
}

/** Raw decoded response line. Exactly one of `ok` / `error` is meaningful. */
export interface InspectorRawResponse {
  id?: number;
  ok?: true;
  error?: string;
  [key: string]: unknown;
}

// --- Result payloads -------------------------------------------------------
//
// Field names below are transcribed from the okResult({...}) literals in
// inspectorserver.cpp; do not rename them.

/** An object reference handed out by findByType / findByProperty / findAndClick. */
export interface ObjectRef {
  /** Registry id. Monotonic integer rendered as a string; stable while the
   *  QObject lives, reissued after deletion. Never reuse one across app runs. */
  id: string;
  /** C++ metaobject class name, e.g. "Button_QMLTYPE_59". */
  type: string;
  objectName: string;
  geometry?: { x: number; y: number; width: number; height: number };
}

export interface FindMatch extends ObjectRef {
  /** Present on findByProperty: the matched property's value. */
  value?: unknown;
}

export interface FindResult {
  matches: FindMatch[];
  count: number;
}

export interface ClickResult {
  clicked: true;
  x: number;
  y: number;
  /** Class name of the widget the event was finally delivered to. */
  widget: string;
}

/**
 * Note the server walks candidates in breadth-first order and, when a click on
 * one fails, moves on to the next text match rather than giving up. It does
 * NOT skip hidden or disabled items — only unresolvable ones — so a match here
 * can be an element the user cannot see. Visibility filtering is ours to do.
 * Failure message: `No clickable element found with text '<text>'`.
 */
export interface FindAndClickResult extends ClickResult {
  matchedText: string;
  matchedType: string;
  matchedId: string;
}

export interface ScreenshotResult {
  /** Base64 PNG. */
  image: string;
  width: number;
  height: number;
  format: "png";
}

export interface SendKeysResult {
  sent: string;
  target: string;
}

export interface EvaluateResult {
  result: unknown;
  undefined: boolean;
}

export interface PropertyEntry {
  name: string;
  value: unknown;
  [key: string]: unknown;
}

export interface GetPropertiesResult {
  properties: PropertyEntry[];
  methods?: Array<{ name: string; signature: string; returnType: string; kind: "signal" | "slot" | "method" }>;
  [key: string]: unknown;
}

export interface TreeNode {
  type?: string;
  objectName?: string;
  id?: string;
  children?: TreeNode[];
  [key: string]: unknown;
}

export interface GetTreeResult {
  tree: TreeNode;
}

/**
 * Only visible AND enabled items are returned, matched against a hardcoded
 * type allow-list: Button, Delegate, TextField, TextInput, TextEdit, ComboBox,
 * Slider, Switch, CheckBox, RadioButton, SpinBox, TabButton, MenuItem and —
 * in the 14-command revision only — MouseArea. Apps that build controls as
 * `Rectangle { Text; MouseArea }` are invisible to the older revision, which
 * is why ../runner//discovery does its own sweep as well.
 */
export interface InteractiveEntry extends ObjectRef {
  text?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** The 14-command revision keys this `elements`; older ones used `matches`. */
export interface ListInteractiveResult {
  matches?: InteractiveEntry[];
  elements?: InteractiveEntry[];
  count?: number;
  [key: string]: unknown;
}

export interface FileDialogEntry {
  id: string;
  [key: string]: unknown;
}

export interface ListFileDialogsResult {
  dialogs: FileDialogEntry[];
}

/** Thrown when the server replies with an `error` key. */
export class InspectorError extends Error {
  constructor(
    readonly command: InspectorCommand,
    readonly serverMessage: string,
    readonly params: Record<string, unknown>,
  ) {
    super(`inspector ${command} failed: ${serverMessage}`);
    this.name = "InspectorError";
  }
}

/** Thrown when the socket is unusable (not listening, closed mid-flight, timeout). */
export class InspectorTransportError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "InspectorTransportError";
  }
}
