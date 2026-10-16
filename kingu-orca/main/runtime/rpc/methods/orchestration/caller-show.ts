import type {
  OrchestrationCallerShowResult,
  OrchestrationPartyLocationResult,
  OrchestrationSessionAddressResult
} from '../../../../../shared/orchestration-caller-status'
import {
  formatKinguSessionAddress,
  isKinguSessionId
} from '../../../../../shared/kingu-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../shared/orchestration-session-caller-codes'
import {
  PartyLocationParams,
  SessionAddressParams
} from '../../../../../shared/rpc-contract/orchestration-params'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { resolveKinguSessionParty } from '../../../orchestration/orchestration-party'
import { locateOrchestrationParty } from '../../../orchestration/orchestration-party-location'
import { readAgentSessionRecordStore } from '../../../orchestration/structured-session-lineage'
import { defineMethod } from '../../core'

export const ORCHESTRATION_CALLER_METHODS = [
  defineMethod({
    name: 'orchestration.callerShow',
    permission: 'workspace',
    params: null,
    // Why no params: the dispatch entry already resolved the session the caller's environment names,
    // and a session it cannot admit never reaches here: its refusal is the answer.
    handler: (_params, { orchestrationCaller }): OrchestrationCallerShowResult => ({
      caller: orchestrationCaller
        ? {
            kinguSessionId: formatKinguSessionAddress(orchestrationCaller.kinguSessionId),
            live: true
          }
        : null
    })
  }),
  defineMethod({
    name: 'orchestration.sessionAddress',
    permission: 'workspace',
    params: SessionAddressParams,
    // Why host-side: only the host's session records know a chat's `/clear` root.
    handler: (params, { runtime }): OrchestrationSessionAddressResult => {
      if (!isKinguSessionId(params.sessionId)) {
        throw new OrchestrationError(
          CODES.unknown,
          `${params.sessionId} is not an Kingu session ID.`,
          { effectsApplied: false }
        )
      }
      const party = resolveKinguSessionParty(params.sessionId, runtime.getOrchestrationDb())
      return { kinguSessionId: formatKinguSessionAddress(party.kinguSessionId) }
    }
  }),
  defineMethod({
    name: 'orchestration.partyLocation',
    permission: 'workspace',
    params: PartyLocationParams,
    // Why host-side: a chat sender's live session follows its `/clear` lineage on this host.
    handler: (params, { runtime }): OrchestrationPartyLocationResult =>
      locateOrchestrationParty(
        params.address,
        {
          db: runtime.getOrchestrationDb(),
          records: readAgentSessionRecordStore(),
          terminalPaneKey: (handle) => runtime.getTerminalPaneKey(handle),
          terminalHandleForPaneKey: (paneKey) => runtime.getTerminalHandleForPaneKey(paneKey)
        },
        params.messageIds
      )
  })
]
