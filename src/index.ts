// Public API, for embedding sitometres in a bigger test harness.
export { InspectorClient, type CommandOptions } from "./inspector/client.js";
export * from "./inspector/protocol.js";
export { LogBuffer, type LogLine, type LogCursor } from "./logs/buffer.js";
export {
  parseLine,
  pairFailures,
  attributeTo,
  learnCallWindow,
  CallWindowTracker,
  type ParsedLine,
  type Signal,
} from "./logs/classify.js";
export { ChildStdoutSource, FileTailSource, type LogSource } from "./logs/source.js";
export { attach, launch, type Session } from "./app/lifecycle.js";
export {
  compareCopies,
  discoverApps,
  knownBuildTime,
  locateBasecamp,
  type DiscoveredApp,
  type PassReason,
  type Provenance,
} from "./app/discover.js";
export { predictStaged, recordStaged, type StagedRecord } from "./app/fingerprint.js";
export { chooseVariant, stageUserDir } from "./app/userdir.js";
export * from "./app/manifest.js";
export { UiSnapshot, type UiNode } from "./runner/snapshot.js";
export { resolveAll, resolveOne, type Selector } from "./runner/selector.js";
export { Runner, type OpenedScope, type RunResult, type StepBudget, type StepResult } from "./runner/runner.js";
export { assessFidelity, type FidelityReport } from "./runner/fidelity.js";
export {
  findNamedSetupSpec,
  findSetupSpec,
  profilesDir,
  resolveSetupSpec,
  runSetupProfile,
  type SetupOptions,
} from "./runner/setup.js";
export { evalTarget, parseDuration, validateSpec, type EvalInput, type Spec, type Step, type Expect } from "./spec/schema.js";
export * from "./timeouts.js";
export {
  boot,
  planStaging,
  stagingNotes,
  type Boot,
  type StagingDecision,
  type StagingPlan,
} from "./session.js";
export { VERSION } from "./version.js";
