import { afterEach, describe, expect, it } from 'vitest'
import { injectedSessionAddress } from '../../../shared/agent-session-caller-env'
import { testKinguSessionId } from '../../../shared/kingu-session-address-test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { resolveKinguSessionParty } from './orchestration-party'

// The CLI spells its own address without the host resolver (it runs before the codec's module
// graph), so it must land on the one mailbox address the resolver gives the same session.
const CHAT = testKinguSessionId('f7a1c0de-1111-4222-8333-444455556666')
const WORKER = testKinguSessionId('a0b1c2d3-0000-4000-8000-00000000abcd')

afterEach(() => {
  structuredWorkerIdentities.clear()
})

describe("the CLI's own address", () => {
  it("is a chat's session address, even beside a pane handle it inherited", () => {
    const hostAddress = resolveKinguSessionParty(CHAT, null).address
    expect(injectedSessionAddress({ KINGU_AGENT_SESSION_ID: CHAT })).toBe(hostAddress)
    expect(
      injectedSessionAddress({
        KINGU_AGENT_SESSION_ID: CHAT,
        KINGU_TERMINAL_HANDLE: 'term_inherited'
      })
    ).toBe(hostAddress)
  })

  it("is a structured worker's minted handle, as the host resolves it", () => {
    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId: WORKER,
      agent: 'claude',
      paneKey: mintStructuredWorkerPaneKey(WORKER),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const hostAddress = resolveKinguSessionParty(WORKER, null).address
    expect(hostAddress).toBe(handle)
    expect(
      injectedSessionAddress({ KINGU_AGENT_SESSION_ID: WORKER, KINGU_TERMINAL_HANDLE: handle })
    ).toBe(hostAddress)
  })
})
