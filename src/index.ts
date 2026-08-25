// Public API, for embedding sitometres in a bigger test harness.
export { InspectorClient } from "./inspector/client.js";
export * from "./inspector/protocol.js";
export { LogBuffer, type LogLine, type LogCursor } from "./logs/buffer.js";
export { parseLine, pairFailures, attributeTo, type ParsedLine, type Signal } from "./logs/classify.js";
export { ChildStdoutSource, FileTailSource, type LogSource } from "./logs/source.js";
export { attach, launch, type Session } from "./app/lifecycle.js";
export { discoverApps, locateBasecamp, type DiscoveredApp } from "./app/discover.js";
export { stageUserDir } from "./app/userdir.js";
export * from "./app/manifest.js";
export { UiSnapshot, type UiNode } from "./runner/snapshot.js";
export { resolveAll, resolveOne, type Selector } from "./runner/selector.js";
export { Runner, type RunResult, type StepResult } from "./runner/runner.js";
export { assessFidelity, type FidelityReport } from "./runner/fidelity.js";
export {
  findSetupSpec,
  profilesDir,
  resolveSetupSpec,
  runSetupProfile,
  type SetupOptions,
} from "./runner/setup.js";
export { validateSpec, type Spec, type Step, type Expect } from "./spec/schema.js";
export { boot, type Boot } from "./session.js";
export { VERSION } from "./version.js";
