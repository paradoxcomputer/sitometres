// ---------------------------------------------------------------------------
// Interactive questions.
//
// Only asked on a TTY, and only when the answer changes what happens. Every
// prompt has a flag equivalent so CI never blocks on one.
// ---------------------------------------------------------------------------

import readline from "node:readline";

const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const DIM = colour ? "\x1b[2m" : "";
const RST = colour ? "\x1b[0m" : "";
const BOLD = colour ? "\x1b[1m" : "";

const CTRL_C = "\u0003";
const DEL = "\u007f";

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.SITOMETRES_NO_PROMPT === undefined;
}

/** Free-text question. */
export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((res) => rl.question(`  ${BOLD}${question}${RST} `, res));
  } finally {
    rl.close();
  }
}

/**
 * Read a secret without echoing it.
 *
 * Raw mode rather than readline, which would print the characters: a wallet
 * password does not belong in terminal scrollback. It does not belong in argv
 * either, which is why --wallet-password is documented as the CI-only route
 * and this prompt is the default.
 */
export async function secret(question: string): Promise<string> {
  process.stdout.write(`  ${BOLD}${question}${RST} `);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === DEL || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}
