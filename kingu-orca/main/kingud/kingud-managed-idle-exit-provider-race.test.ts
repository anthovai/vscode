import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KINGUD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/kingud-idle-exit'
import { bindKingudIdleShutdown, beginKingudIdleExit } from './kingud-managed-idle-exit-host'
import { installKingudManagedIdleExit } from './kingud-managed-idle-exit'
import type * as ManagedIdleExit from './kingud-managed-idle-exit'
import { retireKingudDaemonIfIdle } from './kingud-daemon-retirement'
import { discardKingudIdleStopRecord } from './kingud-idle-stop-record'

const { hasLoadedProviders } = vi.hoisted(() => ({ hasLoadedProviders: vi.fn(() => false) }))

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ hasLoadedProviders })
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  getLocalPtyProvider: () => ({ listProcesses: async () => [] })
}))
vi.mock('../daemon/daemon-init', () => ({ getDaemonEndpointFacts: () => null }))
vi.mock('./kingud-daemon-retirement', () => ({
  countLiveKingudDaemonSessions: vi.fn(async () => 0),
  retireKingudDaemonIfIdle: vi.fn()
}))
vi.mock('./kingud-idle-stop-record', () => ({
  consumeKingudIdleStopRecord: vi.fn(() => null),
  discardKingudIdleStopRecord: vi.fn(),
  writeKingudIdleStopRecord: vi.fn()
}))
vi.mock('./kingud-managed-idle-exit', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedIdleExit>()),
  installKingudManagedIdleExit: vi.fn(() => () => {})
}))

beforeEach(() => {
  vi.clearAllMocks()
  hasLoadedProviders.mockReturnValue(false)
  vi.stubEnv(KINGUD_MANAGED_ACTIVATION_ROOT_ENV, 'test-fence')
})

afterEach(() => vi.unstubAllEnvs())

it.each(['provider', 'client', 'request', 'recent request'])(
  'rechecks a returning %s after daemon retirement before requesting an idle shutdown',
  async (returning) => {
    const activity = { openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }
    const retire = Promise.withResolvers<{ retirement: string; reason: null }>()
    vi.mocked(retireKingudDaemonIfIdle).mockImplementationOnce(async () => ({
      ...(await retire.promise),
      retirement: 'retired',
      liveSessions: 0
    }))
    const shutdown = vi.fn(() => true)
    bindKingudIdleShutdown(shutdown)
    await beginKingudIdleExit('test-profile').start({
      rpc: {
        readClientActivity: () => activity
      },
      agentStates: () => [],
      hasStagedMigration: () => false,
      automationsBusy: () => false,
      registerCleanup: () => {}
    })
    const installed = vi.mocked(installKingudManagedIdleExit).mock.calls.at(-1)?.[0]
    if (!installed) {
      throw new Error('idle monitor was not installed')
    }
    const stopping = installed.stop({ quietSince: 0, stoppedAt: 900_000, timeoutMs: 900_000 })
    hasLoadedProviders.mockReturnValue(returning === 'provider')
    activity.openConnections = returning === 'client' ? 1 : 0
    activity.requestsInFlight = returning === 'request' ? 1 : 0
    activity.lastRequestAt = returning === 'recent request' ? 1 : 0
    retire.resolve({ retirement: 'retired', reason: null })

    expect(await stopping).toBe(false)
    expect(shutdown).not.toHaveBeenCalled()
    expect(discardKingudIdleStopRecord).toHaveBeenCalledWith('test-profile')
  }
)
