// ---------------------------------------------------------------------------
// Performing one user gesture.
//
// Each action resolves its selector against a fresh snapshot, so it sees the
// UI as it is now rather than as it was when the previous step ended.
// ---------------------------------------------------------------------------

import type { InspectorClient } from "../inspector/client.js";
import { resolveOne, type SelectorInput, toSelector } from "./selector.js";
import { isEditableType, UiSnapshot } from "./snapshot.js";

export interface ActionContext {
  inspector: InspectorClient;
  /** Object id of the app's dock, when one is open. Scopes every selector. */
  scopeId: string | null;
}

export interface ActionOutcome {
  /** One line describing what was actually done, for the report. */
  detail: string;
  /** Object id the gesture was delivered to, when applicable. */
  targetId?: string;
  /**
   * A verdict the ACTION itself established, when it learned one.
   *
   * `type:` reads the field back, so it can know the text did not land — and
   * that knowledge used to survive only as prose in `detail`, while the step
   * reported PASS with no checks. An action that proved something failed must
   * be able to say so.
   */
  check?: { verdict: "fail" | "inconclusive"; description: string; detail: string };
}

export async function snapshot(ctx: ActionContext): Promise<UiSnapshot> {
  return UiSnapshot.capture(ctx.inspector, ctx.scopeId ?? undefined);
}

/**
 * How a typed value is allowed to appear in a report.
 *
 * The length is not preserved: a masked value that reveals how many characters
 * long the password is has given away the only thing the mask was hiding.
 */
export function displayText(text: string, secret?: boolean): string {
  return secret ? '"••••••"' : JSON.stringify(text);
}

/**
 * QML's TextInput.echoMode: 0 Normal, 1 NoEcho, 2 Password, 3 PasswordEchoOnEdit.
 *
 * Anything but Normal means the app itself has decided this value must not be
 * shown on screen — so printing it into a report the user pastes into a bug
 * tracker is worse than showing it on their own display.
 */
function hidesInput(echoMode: unknown): boolean {
  return typeof echoMode === "number" && echoMode !== 0;
}

export async function doClick(ctx: ActionContext, sel: SelectorInput): Promise<ActionOutcome> {
  const snap = await snapshot(ctx);
  const m = resolveOne(snap, { ...toSelector(sel), clickable: true });
  await ctx.inspector.clickRef(m.target.id);
  return {
    detail: `clicked ${m.target.type} ${JSON.stringify(m.node.text || m.node.objectName || m.target.id)}`,
    targetId: m.target.id,
  };
}

/**
 * Type into a field.
 *
 * Three obstacles, all in the inspector: `sendKeys` types into whatever holds
 * focus with no way to say what that should be; it maps each character's
 * unicode value straight to a key code, so Enter and Tab are not expressible;
 * and setting `text` directly skips onTextEdited/onAccepted entirely.
 *
 * So we focus the field first (forceActiveFocus, falling back to a click),
 * clear it by property, send the printable characters as real key events, and
 * deliver Enter by invoking the field's own `accepted` signal — which is what
 * onAccepted handlers are actually connected to.
 */
export async function doType(
  ctx: ActionContext,
  action: { into: SelectorInput; text: string; then?: "enter" | "tab" | "none"; clear?: boolean; secret?: boolean },
): Promise<ActionOutcome> {
  const snap = await snapshot(ctx);
  const m = resolveOne(snap, { ...toSelector(action.into), editable: true });
  const field = isEditableType(m.node.type) ? m.node : m.target;
  // Auto-masking backstop, resolved before anything is printed: an app that
  // hides a field's input has already said this value is not for display.
  let secret = action.secret === true;
  if (!secret) {
    try {
      const props = await ctx.inspector.getProperties(field.id);
      secret = hidesInput(props.properties.find((p) => p.name === "echoMode")?.value);
    } catch {
      /* a field with no readable properties is not evidence either way */
    }
  }

  // Focus, in this order and for this reason:
  //
  // `sendKeys` delivers to QApplication::focusWidget(), which is a QWidget.
  // Calling forceActiveFocus() on the QQuickItem only moves focus WITHIN the
  // QQuickWidget's scene — if that widget is not the application's focus widget
  // (routine offscreen, where nothing was ever clicked) the keys go somewhere
  // else entirely and the field silently stays empty. Observed on medusa_ui:
  // activeFocus true, text still "".
  //
  // A synthesised click gives the hosting widget application focus the same way
  // a user's click would, so we click first and then set item focus.
  let focusNote = "";
  // Offscreen there is no window manager to activate anything, so the
  // application focus widget can be null no matter what we click. Ask the
  // hosting QQuickWidget for focus explicitly, then activate its window,
  // before falling back to a click.
  for (const a of snap.ancestors(field)) {
    if (!a.type.includes("QQuickWidget")) continue;
    for (const method of ["activateWindow", "setFocus", "raise"]) {
      try {
        await ctx.inspector.callMethod(a.id, method, []);
      } catch {
        /* best effort; each is absent on some widget types */
      }
    }
    break;
  }
  try {
    await ctx.inspector.clickRef(field.id);
  } catch {
    focusNote = " [could not click the field to focus it]";
  }
  try {
    await ctx.inspector.callMethod(field.id, "forceActiveFocus", []);
  } catch {
    /* not every editable exposes it; the click may have been enough */
  }

  if (action.clear !== false) {
    try {
      await ctx.inspector.setProperty(field.id, "text", "");
    } catch {
      /* not all editables expose a writable text */
    }
  }

  await ctx.inspector.sendKeys(action.text);

  // Verify the keys actually landed rather than reporting a hollow success.
  // If they did not, fall back to assigning the property — which DOES change
  // the value but skips onTextEdited/onAccepted, so we say so plainly.
  let assigned = false;
  // Undefined when the field carries no readable text at all — an editable
  // ComboBox or SpinBox exposes `editText`/`value`, not `text` — or when the
  // read itself failed. Trusting sendKeys there is a guess, and reporting it as
  // a plain success is the guess stated as fact. It is named in the detail.
  let verified: boolean | undefined;
  let readBack: string | undefined;
  try {
    const props = await ctx.inspector.getProperties(field.id);
    const current = props.properties.find((p) => p.name === "text")?.value;
    if (typeof current === "string") {
      readBack = current;
      verified = current.includes(action.text);
      if (!verified) {
        await ctx.inspector.setProperty(
          field.id,
          "text",
          action.clear === false ? current + action.text : action.text,
        );
        // Read back again: setProperty can be refused by a validator or a
        // read-only binding, and saying "assigned the property" when the field
        // is still empty is the same overstatement one level down.
        try {
          const after = await ctx.inspector.getProperties(field.id);
          const now = after.properties.find((p) => p.name === "text")?.value;
          if (typeof now === "string") readBack = now;
          assigned = typeof now === "string" && now.includes(action.text);
          verified = assigned;
        } catch {
          assigned = true;
          verified = undefined;
        }
      }
    }
  } catch {
    /* verified stays undefined: we could not check */
  }

  let post = "";
  const then = action.then ?? "none";
  if (then === "enter") {
    // onAccepted is connected to the `accepted` signal, so emitting it runs the
    // handler that a synthesised Return key could not reach.
    try {
      await ctx.inspector.callMethod(field.id, "accepted", []);
      post = " + Enter";
    } catch {
      post = " + Enter (field has no accepted() signal - handler may not have run)";
    }
  } else if (then === "tab") {
    try {
      await ctx.inspector.callMethod(field.id, "nextItemInFocusChain", []);
      post = " + Tab";
    } catch {
      post = " + Tab (could not advance focus)";
    }
  }

  const how = assigned
    ? " (key events did not reach it; assigned the property instead, so onTextEdited did not fire)"
    : verified === undefined
      ? " (could not read the field back, so this is not confirmed — assert it with `state:` if it matters)"
      : verified
        ? ""
        : " (the field did not take the text, and assigning it did not work either)";
  // `verified === false` proves only that the field's text does not CONTAIN
  // what was typed — an inputMask or a formatter produces exactly that signal
  // on a field that took the input correctly. So it is inconclusive, naming
  // both strings, not a failure.
  const check: ActionOutcome["check"] | undefined =
    verified === false
      ? {
          verdict: "inconclusive",
          description: `the field took ${displayText(action.text, secret)}`,
          detail: `after typing, its text is ${displayText(readBack ?? "", secret)} — a formatter or input mask can do this, so assert the effect with \`state:\` if it matters`,
        }
      : verified === undefined
        ? {
            verdict: "inconclusive",
            description: `the field took ${displayText(action.text, secret)}`,
            detail: "this field exposes no readable text, so the typing could not be confirmed",
          }
        : undefined;

  return {
    detail:
      `typed ${displayText(action.text, secret)} into ${field.type}` +
      `${field.objectName ? ` (${field.objectName})` : ""}${post}${how}${focusNote}`,
    ...(check ? { check } : {}),
    targetId: field.id,
  };
}

export async function doSet(
  ctx: ActionContext,
  action: { target: SelectorInput; property: string; value: unknown },
): Promise<ActionOutcome> {
  const snap = await snapshot(ctx);
  const m = resolveOne(snap, toSelector(action.target));
  await ctx.inspector.setProperty(m.node.id, action.property, action.value);
  return {
    detail: `set ${m.node.type}.${action.property} = ${JSON.stringify(action.value)}`,
    targetId: m.node.id,
  };
}

export async function doEval(ctx: ActionContext, expression: string, rootId: string | null): Promise<ActionOutcome> {
  // Without a root this used to evaluate in GLOBAL scope, so an expression
  // written against the app's own root silently ran somewhere else and reported
  // a result — usually `undefined` — as though it had worked. An eval whose
  // context is not the one the author wrote for is not a weaker check, it is a
  // different one.
  if (!rootId) {
    throw new Error(
      `cannot evaluate ${JSON.stringify(expression)}: the app's QML root was not found, so there is no ` +
        `app context to evaluate it in. Add an \`open:\` step, and check the \`view\` your manifest declares.`,
    );
  }
  const res = await ctx.inspector.evaluate(expression, rootId);
  return { detail: `evaluated ${JSON.stringify(expression)} -> ${JSON.stringify(res.result)}` };
}
