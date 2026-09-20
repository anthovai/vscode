import { describe, expect, it } from 'vitest'

import {
  KINGUD_READINESS_FILENAME,
  kingudLaunchCommand,
  kingudLivenessBlocksGc,
  kingudLivenessProbeCommand,
  KingudRemoteLaunchUnsupportedError,
  parseKingudLiveness,
  parseKingudReadinessOutput
} from './kingud-remote-launch'
import {
  kingudStopFreedTheHost,
  parseKingudStopOutcome,
  stopKingudCommand
} from './kingud-remote-process-control'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')

const SPEC = {
  remoteInstallDir: '/home/u/.kingu-remote/kingud-0.2.0+bb01',
  nodePath: '/usr/bin/node',
  fullVersion: '0.2.0+bb01',
  userDataDir: '/home/u/.kingu',
  bindHost: '127.0.0.1',
  port: 7777
}

const READY_LINE = JSON.stringify({
  type: 'kingu_server_ready',
  schemaVersion: 1,
  runtimeId: 'r1',
  boundEndpoint: 'ws://127.0.0.1:7777',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled',
  pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
  health: { buildHash: 'abc', terminalDaemon: { state: 'live' } }
})

describe('kingudLaunchCommand', () => {
  it('states the bind posture rather than inheriting the build default', () => {
    expect(kingudLaunchCommand(posix, SPEC)).toContain("--bind '127.0.0.1'")
  })

  it('truncates the readiness file, so a stale line cannot be activated on', () => {
    const command = kingudLaunchCommand(posix, SPEC)
    const truncate = command.indexOf(`: > '${SPEC.remoteInstallDir}/${KINGUD_READINESS_FILENAME}'`)
    const launch = command.indexOf('nohup')
    expect(truncate).toBeGreaterThan(-1)
    expect(truncate).toBeLessThan(launch)
  })

  it('exports the version and the shared data root the deploy decided on', () => {
    const command = kingudLaunchCommand(posix, SPEC)
    expect(command).toContain(`KINGU_VERSION '${SPEC.fullVersion}'`.replace(' ', '='))
    expect(command).toContain(`KINGU_USER_DATA='${SPEC.userDataDir}'`)
  })

  it('declares the Windows refusal instead of emitting a command that cannot work', () => {
    expect(() => kingudLaunchCommand(windows, SPEC)).toThrow(KingudRemoteLaunchUnsupportedError)
  })
})

describe('readiness parsing', () => {
  it('extracts the kingu_server_ready payload', () => {
    const parsed = parseKingudReadinessOutput(`${READY_LINE}\n`)
    expect(parsed).toMatchObject({ state: 'ready' })
    expect(parsed.state === 'ready' && parsed.readiness.boundEndpoint).toBe('ws://127.0.0.1:7777')
  })

  it('treats an empty or half-written file as pending, not as a failure', () => {
    expect(parseKingudReadinessOutput('')).toEqual({ state: 'pending' })
    expect(parseKingudReadinessOutput('{"type":"kingu_serv')).toEqual({ state: 'pending' })
  })

  it('reports a complete JSON line that is not a readiness payload as malformed', () => {
    expect(parseKingudReadinessOutput('{"type":"something_else"}')).toMatchObject({
      state: 'malformed'
    })
  })
})

describe('liveness', () => {
  it('reads the pid recorded in the version dir', () => {
    expect(kingudLivenessProbeCommand(posix, SPEC.remoteInstallDir)).toContain('.kingud-pid')
  })

  it.each([
    ['LIVE', 'LIVE', true],
    ['DEAD', 'DEAD', false],
    ['', 'UNKNOWN', true],
    ['garbage', 'UNKNOWN', true]
  ])('parses %s and blocks GC = %s', (output, expected, blocks) => {
    expect(parseKingudLiveness(output)).toBe(expected)
    expect(kingudLivenessBlocksGc(parseKingudLiveness(output))).toBe(blocks)
  })
})

describe('stopping a running kingud', () => {
  it('sends SIGTERM and never SIGKILL', () => {
    const command = stopKingudCommand(posix, SPEC.remoteInstallDir, { waitSeconds: 20 })
    expect(command).toContain('kill -TERM')
    for (const kill of ['kill -9', 'kill -KILL', 'kill -SIGKILL', 'pkill']) {
      expect(command).not.toContain(kill)
    }
  })

  it.each([
    ['STOPPED', 'stopped', true],
    ['ALREADY_EXITED', 'already-exited', true],
    ['NO_PID', 'no-pid', true],
    ['STILL_RUNNING', 'still-running', false],
    ['SIGNAL_FAILED', 'signal-failed', false],
    ['', 'unknown', false]
  ])('parses %s and frees the host = %s', (output, expected, frees) => {
    expect(parseKingudStopOutcome(output)).toBe(expected)
    expect(kingudStopFreedTheHost(parseKingudStopOutcome(output))).toBe(frees)
  })
})
