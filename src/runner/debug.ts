// ---------------------------------------------------------------------------
// Interactive debug mode for sitometres.
//
// Provides a REPL interface for pausing test execution and inspecting state.
// Uses Node.js built-in readline module for zero additional dependencies.
// ---------------------------------------------------------------------------

import * as readline from "node:readline";
import { status } from "../report/status.js";

export interface DebugContext {
  /** Whether debug mode is currently active */
  active: boolean;
  /** Current step number (1-indexed) */
  stepNumber: number;
  /** Current step description */
  stepDescription: string;
  /** Whether this pause is at a breakpoint */
  isBreakpoint: boolean;
  /** Whether this pause is due to a failure */
  isFailure: boolean;
  /** User-requested breakpoint step number (if any) */
  breakpointStep?: number;
}

export interface DebugCallbacks {
  /** Get current QML state */
  getState: () => Promise<string>;
  /** Get current log evidence */
  getLogs: () => Promise<string>;
  /** Get current UI snapshot */
  getUI: () => Promise<string>;
  /** Execute next step */
  nextStep: () => Promise<void>;
  /** Continue execution (disable pause points) */
  continueExecution: () => void;
  /** Quit the test run */
  quit: () => Promise<void>;
}

/**
 * Create and manage the debug REPL interface.
 *
 * Returns a function that should be called to pause execution and enter debug mode.
 */
export function createDebugREPL(
  context: DebugContext,
  callbacks: DebugCallbacks,
): () => Promise<"next" | "continue" | "quit"> {
  return async (): Promise<"next" | "continue" | "quit"> => {
    // Nobody is there to answer. Waiting on a closed or piped stdin is an
    // unkillable hang — it is what made `node --test` never exit — and a
    // `--debug` run under CI should degrade to a normal run, not wedge.
    if (!process.stdin.isTTY) {
      console.log("  --debug needs an interactive terminal; continuing without pausing.");
      return "continue";
    }

    // Created HERE, not once when the REPL was built. Building it up front
    // held process.stdin open for the whole run, so the process could never
    // exit on its own; registered a new "line" listener on every pause, so the
    // n-th pause handled each keystroke n times; and froze the prompt at
    // whatever step happened to be current when the Runner was constructed.
    // The status line repaints every 100 ms; without suspending it, the prompt
    // is erased about a tenth of a second after it is printed.
    status.suspend();
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: getPrompt(context),
    });

    try {
      return await new Promise<"next" | "continue" | "quit">((resolve) => {
        rl.on("line", (line: string) => {
          void (async () => {
            const cmd = line.trim().toLowerCase();
            try {
              const result = await handleCommand(cmd, context, callbacks, rl);
              if (result !== "pause") resolve(result);
              else rl.prompt();
            } catch (err) {
              console.error(`  Error: ${(err as Error).message}`);
              rl.prompt();
            }
          })();
        });
        // Ctrl-D, or stdin closing under us. Treat it as "stop pausing" rather
        // than leaving the run blocked on input that will never come.
        rl.once("close", () => resolve("continue"));
        rl.prompt();
      });
    } finally {
      rl.close();
      status.resume();
    }
  };
}

function getPrompt(context: DebugContext): string {
  const prefix = context.isFailure ? "FAILURE" : context.isBreakpoint ? "BREAKPOINT" : "DEBUG";
  const step = `Step ${context.stepNumber}`;
  return `${prefix} [${step}]: ${context.stepDescription.slice(0, 30)}... > `;
}

/**
 * Format output for better readability in debug mode.
 */
function formatOutput(output: string): string {
  // If it's JSON, pretty-print it
  try {
    const parsed = JSON.parse(output);
    return JSON.stringify(parsed, null, 2);
  } catch {
    // Not JSON, return as-is but with indentation
    return output.split('\n').map(line => `  ${line}`).join('\n');
  }
}

async function handleCommand(
  cmd: string,
  context: DebugContext,
  callbacks: DebugCallbacks,
  rl: readline.Interface,
): Promise<"next" | "continue" | "quit" | "pause"> {
  const parts = cmd.split(/\s+/);
  const command = parts[0];
  const arg = parts[1];

  switch (command) {
    case "h":
    case "help":
      showHelp(arg);
      return "pause";

    case "s":
    case "state":
      console.log("\n  QML State:");
      const state = await callbacks.getState();
      console.log(formatOutput(state));
      return "pause";

    case "l":
    case "logs":
      console.log("\n  Log Evidence:");
      const logs = await callbacks.getLogs();
      console.log(formatOutput(logs));
      return "pause";

    case "u":
    case "ui":
      console.log("\n  UI Snapshot:");
      const ui = await callbacks.getUI();
      console.log(formatOutput(ui));
      return "pause";

    case "n":
    case "next":
      await callbacks.nextStep();
      return "next";

    case "c":
    case "continue":
      callbacks.continueExecution();
      return "continue";

    case "q":
    case "quit":
      await callbacks.quit();
      return "quit";

    default:
      console.log(`  Unknown command: ${command}. Type 'help' for available commands.`);
      return "pause";
  }
}

function showHelp(arg?: string): void {
  if (arg) {
    showCommandHelp(arg);
    return;
  }

  console.log(`
Available commands:
  h, help              Show this help
  h, help <command>    Show detailed help for a command
  s, state             Show current QML state
  l, logs              Show log evidence for current step
  u, ui                Show current UI snapshot
  n, next              Execute next step and pause
  c, continue          Continue execution without pausing
  q, quit              Quit the test run

For more information on a specific command, type: help <command>
`);
}

function showCommandHelp(command: string): void {
  const helps: Record<string, { short: string; long: string }> = {
    state: {
      short: "Display the current QML root state, showing relevant properties and their values.",
      long: `Displays the current QML root state by evaluating the root object in the app's context.
Shows relevant properties and their current values. Useful for understanding the app's internal state
at the current point in execution. Requires the app to be opened (QML root available).`,
    },
    logs: {
      short: "Display the log evidence for the current step window, showing classified signals and their sequence.",
      long: `Displays the log evidence for the current step window, showing classified signals and their sequence.
Shows which backend calls were made, any failures, and other log events. This helps you understand what
the app actually did during the current step, which is especially useful when debugging unexpected behavior.`,
    },
    ui: {
      short: "Display the current UI control tree, showing visible controls with their properties.",
      long: `Displays the current UI control tree as captured by the inspector, showing visible controls with their properties.
This helps you understand what the user interface looks like at the current moment, which is useful for verifying
that the app is in the expected state or debugging selector issues.`,
    },
    next: {
      short: "Execute the current step, then pause before the next step.",
      long: `Executes the current step and then pauses again before the next step. This allows you to step through
the spec one step at a time, inspecting the state after each action. Useful for detailed debugging of
specific steps.`,
    },
    continue: {
      short: "Execute all remaining steps without pausing. Normal execution resumes until completion or next failure.",
      long: `Disables debug pause points and executes all remaining steps without pausing. Normal execution resumes
until the spec completes or another failure occurs. Use this when you want to continue execution after
debugging a specific issue.`,
    },
    quit: {
      short: "Terminate the test run. Cleanup procedures run normally to remove throwaway directories and reap processes.",
      long: `Terminates the test run immediately. All cleanup procedures run normally to remove throwaway directories
and reap Basecamp processes. The sandbox is properly cleaned up, so no temporary files or processes are left behind.`,
    },
  };

  const help = helps[command];
  if (help) {
    console.log(`  ${command}:`);
    console.log(`    ${help.short}`);
    console.log(`    ${help.long}`);
  } else {
    console.log(`  Unknown command: ${command}. Type 'help' for available commands.`);
  }
}