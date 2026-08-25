// ---------------------------------------------------------------------------
// Typed client for the Logos QML inspector (see ./protocol.ts for the wire
// contract). Owns the socket, request/response correlation and timeouts.
//
// What this adds over logos-qt-mcp's reference framework.mjs:
//
//   * textInventory() — one findByProperty call with the value omitted returns
//     EVERY object carrying a `text` property together with its value. The
//     server only ever compares values for exact equality, so substring and
//     regex matching (and "did you mean ...?" suggestions) have to happen
//     client-side; this is the primitive that makes that cheap.
//   * clickRef() — click by object id, so we can drive controls that have no
//     `text` property at all. findAndClick can only ever find text-bearing
//     objects, which silently excludes icon-only buttons.
//   * every call is timed, so the runner can attribute latency to the UI step.
// ---------------------------------------------------------------------------

import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  type ClickResult,
  type EvaluateResult,
  type FindAndClickResult,
  type FindMatch,
  type FindResult,
  type GetPropertiesResult,
  type GetTreeResult,
  type InspectorCommand,
  InspectorError,
  type InspectorRawResponse,
  InspectorTransportError,
  type InteractiveEntry,
  type ListFileDialogsResult,
  type ListInteractiveResult,
  type ScreenshotResult,
  type SendKeysResult,
} from "./protocol.js";

export interface InspectorClientOptions {
  host?: string;
  port?: number;
  /** Per-command deadline. getTree on a deep tree is the slow one. */
  timeoutMs?: number;
}

export interface TimedResponse<T> {
  data: T;
  /** Wall-clock milliseconds from write to reply. */
  elapsedMs: number;
}

interface Pending {
  resolve: (value: InspectorRawResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  command: InspectorCommand;
}

export const DEFAULT_INSPECTOR_HOST = "127.0.0.1";
export const DEFAULT_INSPECTOR_PORT = 3768;

export class InspectorClient {
  readonly host: string;
  readonly port: number;
  private readonly timeoutMs: number;

  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  /** Set when the socket dies, so later calls fail with the real cause rather
   *  than a generic "connection closed". */
  private fatal: Error | null = null;
  /** Which inspector revision we are talking to. Filled by probeCapabilities(). */
  private caps: { fileDialogs: boolean } | null = null;

  constructor(opts: InspectorClientOptions = {}) {
    this.host = opts.host ?? process.env.QML_INSPECTOR_HOST ?? DEFAULT_INSPECTOR_HOST;
    this.port = opts.port ?? Number(process.env.QML_INSPECTOR_PORT ?? DEFAULT_INSPECTOR_PORT);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  // --- connection ----------------------------------------------------------

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.fatal = null;
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const onError = (err: Error) => {
        sock.destroy();
        reject(new InspectorTransportError(`cannot reach the QML inspector at ${this.host}:${this.port} — ${err.message}`, err));
      };
      sock.once("error", onError);
      sock.once("connect", () => {
        sock.off("error", onError);
        sock.setNoDelay(true);
        this.attach(sock);
        resolve();
      });
    });
  }

  /**
   * Poll until the inspector accepts a connection. The port opening is
   * necessary but NOT sufficient for the app to be usable — plugins load
   * afterwards. Readiness gating lives in ../app/lifecycle.ts.
   */
  async waitUntilListening(opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        await this.connect();
        return;
      } catch (err) {
        last = err;
        await sleep(intervalMs);
      }
    }
    throw new InspectorTransportError(
      `QML inspector never came up on ${this.host}:${this.port} within ${timeoutMs}ms. ` +
        `Is Basecamp built with the inspector enabled (ENABLE_QML_INSPECTOR=ON)?`,
      last,
    );
  }

  private attach(sock: net.Socket): void {
    this.socket = sock;
    this.buffer = "";
    // A StringDecoder, not chunk.toString(): TCP splits wherever it likes, and
    // decoding each chunk independently turns a multi-byte character straddling
    // a 64 KB boundary into U+FFFD in BOTH halves. The JSON still parses, so the
    // damage surfaces as a label that does not match the developer's selector —
    // a false FAIL for text that is genuinely on screen, offered back as a
    // mojibake did-you-mean. For a CJK or Cyrillic app it corrupts constantly.
    const decoder = new StringDecoder("utf8");
    sock.on("data", (chunk) => {
      this.buffer += decoder.write(chunk);
      this.drain();
    });
    sock.on("error", (err) => this.tearDown(new InspectorTransportError(`inspector socket error: ${err.message}`, err)));
    sock.on("close", () => this.tearDown(new InspectorTransportError("inspector closed the connection (did the app exit?)")));
  }

  private tearDown(err: Error): void {
    this.fatal = err;
    this.socket = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private drain(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: InspectorRawResponse;
      try {
        msg = JSON.parse(line) as InspectorRawResponse;
      } catch {
        // The server only ever writes compact JSON + "\n"; a non-JSON line means
        // something else is on the port. Surface it rather than silently dropping.
        this.tearDown(new InspectorTransportError(`unparseable line from inspector: ${truncate(line, 200)}`));
        return;
      }
      const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!p) continue; // unsolicited / already timed out
      clearTimeout(p.timer);
      this.pending.delete(msg.id as number);
      p.resolve(msg);
    }
  }

  disconnect(): void {
    const sock = this.socket;
    this.socket = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new InspectorTransportError("client disconnected"));
    }
    this.pending.clear();
    sock?.destroy();
  }

  // --- raw send ------------------------------------------------------------

  async sendTimed<T>(command: InspectorCommand, params: Record<string, unknown> = {}): Promise<TimedResponse<T>> {
    if (this.fatal && !this.connected) throw this.fatal;
    await this.connect();
    const sock = this.socket;
    if (!sock) throw this.fatal ?? new InspectorTransportError("not connected");

    const id = this.nextId++;
    const started = Date.now();
    const raw = await new Promise<InspectorRawResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new InspectorTransportError(
            `inspector command "${command}" timed out after ${this.timeoutMs}ms. ` +
              `The Qt GUI thread services these synchronously, so a hung UI handler blocks the socket.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command });
      sock.write(JSON.stringify({ id, command, params }) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new InspectorTransportError(`write failed: ${err.message}`, err));
        }
      });
    });

    if (typeof raw.error === "string") throw new InspectorError(command, raw.error, params);
    return { data: raw as unknown as T, elapsedMs: Date.now() - started };
  }

  async send<T>(command: InspectorCommand, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.sendTimed<T>(command, params)).data;
  }

  /**
   * Detect which inspector revision is on the other end.
   *
   * Several revisions ship in the wild; the newer one adds the file-dialog
   * commands and includes MouseArea in listInteractive. `listFileDialogs` is
   * the cheapest discriminator: the newer revision answers `{dialogs: []}`,
   * the older one `Unknown command: listFileDialogs`.
   */
  async probeCapabilities(): Promise<{ fileDialogs: boolean }> {
    if (this.caps) return this.caps;
    try {
      await this.send<ListFileDialogsResult>("listFileDialogs");
      this.caps = { fileDialogs: true };
    } catch (err) {
      if (err instanceof InspectorError && /Unknown command/i.test(err.serverMessage)) {
        this.caps = { fileDialogs: false };
      } else {
        throw err;
      }
    }
    return this.caps;
  }

  // --- commands ------------------------------------------------------------

  /**
   * Click by object id. Works for any widget or QQuickItem, text or not.
   *
   * The events are POSTED, not sent: this resolves once they are on the queue,
   * which is strictly before any handler runs. Never treat a resolved click as
   * evidence that something happened — wait for the effect instead.
   */
  clickRef(objectId: string, at?: { x: number; y: number }): Promise<ClickResult> {
    return this.send<ClickResult>("click", at ? { objectId, ...at } : { objectId });
  }

  /** Click at raw root-widget coordinates. Last resort. */
  clickAt(x: number, y: number): Promise<ClickResult> {
    return this.send<ClickResult>("click", { x, y });
  }

  /**
   * Server-side find-then-click on the `text` property.
   *
   * Case-insensitive substring unless `exact`; breadth-first order decides
   * among multiple matches. Two traps this cannot avoid for you:
   * objects without a `text` property are unreachable, and hidden or disabled
   * items are matched and "clicked" just the same. ../runner/selector.ts
   * resolves selectors client-side for exactly that reason.
   */
  findAndClick(text: string, opts: { type?: string; exact?: boolean } = {}): Promise<FindAndClickResult> {
    const params: Record<string, unknown> = { text };
    if (opts.type) params.type = opts.type;
    if (opts.exact) params.exact = true;
    return this.send<FindAndClickResult>("findAndClick", params);
  }

  findByType(typeName: string): Promise<FindResult> {
    return this.send<FindResult>("findByType", { typeName });
  }

  /** Exact-value match. Omit `value` to enumerate every object having the property. */
  findByProperty(property: string, value?: unknown): Promise<FindResult> {
    return this.send<FindResult>("findByProperty", value === undefined ? { property } : { property, value });
  }

  /**
   * Every object in the tree that carries a `text` property, with its value.
   * The basis for substring/regex assertions and for suggesting near-misses
   * when an expected label is absent.
   */
  async textInventory(): Promise<Array<FindMatch & { text: string }>> {
    const res = await this.findByProperty("text");
    return (res.matches ?? [])
      .map((m) => ({ ...m, text: typeof m.value === "string" ? m.value : String(m.value ?? "") }))
      .filter((m) => m.text.length > 0);
  }

  getProperties(objectId: string): Promise<GetPropertiesResult> {
    return this.send<GetPropertiesResult>("getProperties", { objectId });
  }

  setProperty(objectId: string, property: string, value: unknown): Promise<unknown> {
    return this.send("setProperty", { objectId, property, value });
  }

  /** Invoke a Q_INVOKABLE/slot. The server caps arity at 4 arguments. */
  callMethod(objectId: string, method: string, args: unknown[] = []): Promise<{ invoked: string }> {
    return this.send<{ invoked: string }>("callMethod", { objectId, method, args });
  }

  getTree(opts: { depth?: number; objectId?: string } = {}): Promise<GetTreeResult> {
    const params: Record<string, unknown> = {};
    if (opts.depth !== undefined) params.depth = opts.depth;
    if (opts.objectId) params.objectId = opts.objectId;
    return this.send<GetTreeResult>("getTree", params);
  }

  async listInteractive(): Promise<InteractiveEntry[]> {
    const res = await this.send<ListInteractiveResult>("listInteractive");
    return res.matches ?? res.elements ?? [];
  }

  /** File dialogs currently open. Empty array when the revision lacks support. */
  async listFileDialogs(): Promise<ListFileDialogsResult["dialogs"]> {
    const caps = await this.probeCapabilities();
    if (!caps.fileDialogs) return [];
    const res = await this.send<ListFileDialogsResult>("listFileDialogs");
    return res.dialogs ?? [];
  }

  /** Drive an open file dialog (accept/reject/select a path). */
  async fileDialogAction(objectId: string, action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const caps = await this.probeCapabilities();
    if (!caps.fileDialogs) {
      throw new InspectorTransportError(
        "this Basecamp build's QML inspector predates file-dialog support; rebuild against a newer logos-qt-mcp",
      );
    }
    return this.send("fileDialogAction", { objectId, action, ...extra });
  }

  screenshot(objectId?: string): Promise<ScreenshotResult> {
    return this.send<ScreenshotResult>("screenshot", objectId ? { objectId } : {});
  }

  /**
   * Type into whatever currently holds focus.
   *
   * Limitation baked into the server: it maps each QChar's unicode value
   * straight to a Qt key code, so only printable characters survive. Enter,
   * Tab and Backspace are NOT expressible — see ../runner for how we work
   * around that (focus + setProperty on the text field).
   */
  sendKeys(text: string): Promise<SendKeysResult> {
    return this.send<SendKeysResult>("sendKeys", { text });
  }

  /** Evaluate a QML expression in the root context. */
  evaluate(expression: string, objectId?: string): Promise<EvaluateResult> {
    return this.send<EvaluateResult>("evaluate", objectId ? { expression, objectId } : { expression });
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
