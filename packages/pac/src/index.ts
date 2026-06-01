/**
 * @description @teya/pac — BitGN benchmark integration for Teya.
 *
 * Public surface:
 *   - runBenchmark / RunnerOptions / RunSummary — programmatic entry
 *   - pacCli                                      — `teya pac ...` subcommand
 *   - harnessClient / miniClient / pcmClient      — raw Connect-RPC clients
 *   - buildMiniTools / buildPcmTools              — tool bridges for custom runs
 */
export { runBenchmark } from './runner.js'
export type { RunnerOptions, TrialResult, RunSummary } from './runner.js'
export { pacCli } from './cli.js'
export {
  harnessClient,
  miniClient,
  pcmClient,
  DEFAULT_BITGN_HOST,
} from './client.js'
export type { HarnessClient, MiniClient, PcmClient } from './client.js'
export { buildMiniTools, buildPcmTools, ANSWER_SENTINEL, type AnswerBox } from './tools.js'
