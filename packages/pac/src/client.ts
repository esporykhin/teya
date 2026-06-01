/**
 * @description Connect-RPC clients for the BitGN benchmark platform.
 *
 * Three services:
 *   HarnessService — control plane at api.bitgn.com (StartRun, StartTrial,
 *                    EndTrial, SubmitRun, StartPlayground). Platform API key
 *                    required for leaderboard runs; sandbox/playground is free.
 *
 *   MiniRuntime    — per-trial data plane for the `bitgn/sandbox` benchmark.
 *                    Simpler VM: outline/search/list/read/write/delete/answer.
 *
 *   PcmRuntime     — per-trial data plane for `bitgn/pac/*` benchmarks.
 *                    Full VM: tree/find/search/list/read/write/delete/mkdir/
 *                    move/context/answer.
 *
 * All per-trial clients are built against the harness_url returned by
 * StartTrialResponse / StartPlaygroundResponse.
 */
import { createPromiseClient, type PromiseClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { HarnessService } from '@buf/bitgn_api.connectrpc_es/bitgn/harness_connect.js'
import { MiniRuntime } from '@buf/bitgn_api.connectrpc_es/bitgn/vm/mini_connect.js'
import { PcmRuntime } from '@buf/bitgn_api.connectrpc_es/bitgn/vm/pcm_connect.js'

export const DEFAULT_BITGN_HOST = 'https://api.bitgn.com'

export type HarnessClient = PromiseClient<typeof HarnessService>
export type MiniClient = PromiseClient<typeof MiniRuntime>
export type PcmClient = PromiseClient<typeof PcmRuntime>

/** Build a HarnessService client pointed at the control plane. */
export function harnessClient(baseUrl: string = DEFAULT_BITGN_HOST): HarnessClient {
  return createPromiseClient(
    HarnessService,
    createConnectTransport({
      baseUrl,
      httpVersion: '1.1',
    }),
  )
}

/** Build a MiniRuntime client for a sandbox trial. */
export function miniClient(harnessUrl: string): MiniClient {
  return createPromiseClient(
    MiniRuntime,
    createConnectTransport({
      baseUrl: harnessUrl,
      httpVersion: '1.1',
    }),
  )
}

/** Build a PcmRuntime client for a PAC trial. */
export function pcmClient(harnessUrl: string): PcmClient {
  return createPromiseClient(
    PcmRuntime,
    createConnectTransport({
      baseUrl: harnessUrl,
      httpVersion: '1.1',
    }),
  )
}
