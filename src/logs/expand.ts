// ---------------------------------------------------------------------------
// One physical line is not always one logical line.
//
// When a plugin ships a C++ view module (metadata.json has a non-empty "main"),
// Basecamp spawns a separate `ui-host` process and re-emits that child's entire
// output as a SINGLE quoted QString with literal \n escapes:
//
//   ui-host [ "logos_wallet" ]: "ui-host: loaded plugin \"logos_wallet\" from \"/…\"\nnext line\n…"
//
// Several kilobytes of the backend's own logging can hide inside one line, so
// line-oriented matching would never see the evidence for a view-module app
// like zonescan_lite. Expanding these before classification is what lets the
// same assertions work for both plugin shapes.
// ---------------------------------------------------------------------------

const UI_HOST_LINE = /^ui-host \[ "([^"]+)" \]: "(.*)"\s*$/;

export interface ExpandedLine {
  text: string;
  /** Set when the line came out of a ui-host envelope, naming the child module. */
  viaUiHost?: string;
}

/**
 * Expand a raw line into one or more logical lines.
 * Non-envelope lines pass through untouched and unallocated.
 */
export function expandLine(raw: string): ExpandedLine[] {
  const m = UI_HOST_LINE.exec(raw);
  if (!m) return [{ text: raw }];

  const module = m[1]!;
  const body = unescapeQString(m[2]!);
  const parts = body.split("\n").filter((p) => p.length > 0);
  if (parts.length === 0) return [{ text: raw }];
  return parts.map((text) => ({ text, viaUiHost: module }));
}

/** Undo the escaping Qt applies when a QString is streamed with quotes. */
function unescapeQString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = s[++i];
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case undefined: out += "\\"; break;
      default: out += "\\" + next; break;
    }
  }
  return out;
}
