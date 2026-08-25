// ---------------------------------------------------------------------------
// Which wallet identity should the app under test run against?
//
// Many Basecamp apps are useless without one: tip_jar cannot tip, medusa_ui
// opens on "Create your wallet". sitometres gives every run a throwaway $HOME,
// so by default the app meets a brand-new wallet — which is the right default
// (it is reproducible, and it is what a first-time user sees) but it is not
// always what you want to test.
//
// The alternative is your real wallet, which means dropping the HOME sandbox
// and unlocking with your password. That is a deliberate, stated choice, never
// a default: a test run that silently drives a funded wallet is exactly the
// accident this tool should not enable.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InspectorClient } from "../inspector/client.js";
import type { DiscoveredApp } from "./discover.js";
import { isPureQml } from "./manifest.js";

export type WalletChoice = "fresh" | "real";

export interface WalletProvider {
  /** Module that owns the wallet, e.g. "medusa_core". */
  module: string;
  /** Human name for prompts. */
  name: string;
  /** Whether it has an unlock verb, i.e. whether a password means anything. */
  needsPassword: boolean;
  /** Where its store lives when not sandboxed. */
  storePath: string;
  /** True when a real wallet exists there today. */
  hasStore: boolean;
}

/**
 * Wallet modules sitometres knows how to talk to.
 *
 * They differ in a way that matters: `logos_wallet` — the standard LEZ wallet,
 * and what most people will be using — exposes no unlock verb at all. Its
 * store is not encrypted, so asking for a password would be theatre. Only
 * Medusa has `unlock(password)`, so only Medusa is ever asked for one.
 */
const PROVIDERS: Array<{
  module: string;
  name: string;
  needsPassword: boolean;
  store: (home: string) => string;
}> = [
  {
    module: "logos_wallet",
    name: "Logos wallet (standard LEZ)",
    needsPassword: false,
    store: (h) => path.join(h, ".local/share/logos-wallet-home"),
  },
  {
    module: "medusa_core",
    name: "Medusa",
    needsPassword: true,
    store: (h) => path.join(h, ".local/share/medusa-wallet-home/storage.json"),
  },
];

/**
 * The wallet an app depends on, if any.
 *
 * Only reported for pure-QML plugins: unlocking goes through the `logos`
 * bridge in the app's own QML, and a view-module plugin does not have one.
 */
export function detectWalletProvider(app: DiscoveredApp, staged: DiscoveredApp[]): WalletProvider | null {
  if (!isPureQml(app.manifest)) return null;
  const names = new Set(staged.map((s) => s.manifest.name));
  const home = os.homedir();
  for (const p of PROVIDERS) {
    if (!app.manifest.dependencies.includes(p.module) && !names.has(p.module)) continue;
    const storePath = p.store(home);
    return {
      module: p.module,
      name: p.name,
      needsPassword: p.needsPassword,
      storePath,
      hasStore: fs.existsSync(storePath),
    };
  }
  return null;
}

export interface WalletPlan {
  choice: WalletChoice;
  provider: WalletProvider | null;
  password?: string;
}

/**
 * Unlock the wallet through the app's own bridge.
 *
 * `logos.callModule` is injected into every pure-QML plugin, so the app under
 * test can reach its wallet module without sitometres knowing anything about
 * that module beyond the verb name. Returns null on success, else the reason.
 */
export async function unlockWallet(
  inspector: InspectorClient,
  qmlRootId: string,
  provider: WalletProvider,
  password: string,
): Promise<string | null> {
  const expr =
    `JSON.stringify(logos.callModule(${JSON.stringify(provider.module)}, "unlock", ` +
    `[${JSON.stringify(password)}]))`;
  let raw: unknown;
  try {
    raw = (await inspector.evaluate(expr, qmlRootId)).result;
  } catch (err) {
    return `could not reach ${provider.module} through the app's logos bridge: ${(err as Error).message}`;
  }
  // The bridge hands errors back as a JSON payload rather than throwing.
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  const unwrapped = unwrapJson(text);
  if (/"error"\s*:/.test(unwrapped)) {
    const m = /"error"\s*:\s*"([^"]*)"/.exec(unwrapped);
    return m?.[1] ?? "the wallet module returned an error";
  }
  if (/\bfalse\b/.test(unwrapped) && !/true/.test(unwrapped)) {
    return "the wallet refused the password";
  }
  return null;
}

/** callModule results arrive JSON-encoded, sometimes twice over. */
function unwrapJson(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    if (!out.startsWith('"')) break;
    try {
      const next = JSON.parse(out) as unknown;
      if (typeof next !== "string") break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Which $HOME the run gets, and which wallet it unlocks.
 *
 * Exported because it is the one decision in the CLI that can quietly hand an
 * app the developer's real data. A password used to imply the real HOME, so
 * `--wallet-password` alone un-sandboxed the run — while the header still said
 * "creating a throwaway HOME so your real data is untouched". Unlocking a
 * wallet and choosing which wallet exists are different questions, and only
 * --real-home answers the second.
 */
export function homeAndWallet(
  realHome: boolean,
  password?: string,
): { realHome?: true; wallet?: { choice: "fresh" | "real"; password?: string } } {
  const out: { realHome?: true; wallet?: { choice: "fresh" | "real"; password?: string } } = {};
  if (realHome) out.realHome = true;
  if (realHome || password) {
    out.wallet = {
      choice: realHome ? "real" : "fresh",
      ...(password ? { password } : {}),
    };
  }
  return out;
}
