import { describe, expect, it } from 'vitest'
import {
  classifyWslKingudLiveness,
  nextWslLivenessProbe,
  terminalVerdictOf,
  type WslLivenessEvidence
} from './wsl-kingud-liveness-verdict'

const INSTANCE = 'boot-a:100'
const KINGUD = '321:5000'

function evidence(overrides: Partial<WslLivenessEvidence> = {}): WslLivenessEvidence {
  return {
    trigger: { source: 'bridge', code: 1 },
    running: { status: 'confirmed', running: true },
    expected: { distroInstance: INSTANCE, kingud: KINGUD },
    ...overrides
  }
}

describe('classifyWslKingudLiveness', () => {
  it('reads a failed running-list probe as unverifiable, never exited, whatever the exit code', () => {
    for (const code of [0, 1, null]) {
      const verdict = classifyWslKingudLiveness(
        evidence({ trigger: { source: 'bridge', code }, running: { status: 'unavailable' } })
      )
      expect(verdict).toEqual({ kind: 'unverifiable', reason: 'running-list-unavailable' })
      expect(terminalVerdictOf(verdict)).toBe('unverifiable')
    }
  })

  it('marks every terminal exited when the distro is confirmed stopped', () => {
    const verdict = classifyWslKingudLiveness(
      evidence({ running: { status: 'confirmed', running: false } })
    )
    expect(verdict).toEqual({ kind: 'distro-stopped', corroborated: true })
    expect(terminalVerdictOf(verdict)).toBe('exited')
  })

  it('needs no exit code to prove a stop, but only a failed exit corroborates it', () => {
    const stopped = { status: 'confirmed', running: false } as const
    expect(
      classifyWslKingudLiveness(evidence({ trigger: { source: 'verify' }, running: stopped }))
    ).toEqual({ kind: 'distro-stopped', corroborated: false })
    expect(
      classifyWslKingudLiveness(
        evidence({ trigger: { source: 'holder', code: 0 }, running: stopped })
      )
    ).toEqual({ kind: 'distro-stopped', corroborated: false })
  })

  it('treats a running distro whose guest did not answer as unverifiable', () => {
    expect(classifyWslKingudLiveness(evidence({ identity: null }))).toEqual({
      kind: 'unverifiable',
      reason: 'guest-unanswered'
    })
  })

  it('proves a restart from a new boot id or pid 1 start time, without any wall clock', () => {
    const verdict = classifyWslKingudLiveness(
      evidence({ identity: { distroInstance: 'boot-a:900', kingud: null } })
    )
    expect(verdict).toEqual({ kind: 'distro-restarted' })
    expect(terminalVerdictOf(verdict)).toBe('exited')
  })

  it('reads a gone or reused kingud pid in the same incarnation as kingud exited', () => {
    for (const kingud of [null, '321:7777']) {
      const verdict = classifyWslKingudLiveness(
        evidence({
          trigger: { source: 'bridge', code: 0 },
          identity: { distroInstance: INSTANCE, kingud }
        })
      )
      expect(verdict).toEqual({ kind: 'kingud-exited' })
      // The census decides about terminals after the relaunch, not the crash.
      expect(terminalVerdictOf(verdict)).toBeNull()
    }
  })

  it('keeps kingud live when the same process still runs, even after a bridge exit', () => {
    expect(
      classifyWslKingudLiveness(
        evidence({
          trigger: { source: 'bridge', code: 0 },
          identity: { distroInstance: INSTANCE, kingud: KINGUD }
        })
      )
    ).toEqual({ kind: 'live' })
  })

  it('falls back to the port when no kingud pid was known', () => {
    const base = evidence({
      expected: { distroInstance: INSTANCE, kingud: null },
      identity: { distroInstance: INSTANCE, kingud: null }
    })
    expect(classifyWslKingudLiveness({ ...base, kingudPort: 'ready' })).toEqual({ kind: 'live' })
    expect(classifyWslKingudLiveness({ ...base, kingudPort: 'refused' })).toEqual({
      kind: 'kingud-exited'
    })
    expect(classifyWslKingudLiveness({ ...base, kingudPort: 'unverifiable' })).toEqual({
      kind: 'unverifiable',
      reason: 'kingud-unanswered'
    })
  })
})

describe('nextWslLivenessProbe', () => {
  it('never probes inside a distro that is not confirmed running (an exec would boot it)', () => {
    expect(nextWslLivenessProbe(evidence({ running: { status: 'unavailable' } }))).toBeNull()
    expect(
      nextWslLivenessProbe(evidence({ running: { status: 'confirmed', running: false } }))
    ).toBeNull()
  })

  it('asks for identity first, and for the port only when no pid identity can decide', () => {
    expect(nextWslLivenessProbe(evidence())).toBe('identity')
    expect(
      nextWslLivenessProbe(evidence({ identity: { distroInstance: INSTANCE, kingud: KINGUD } }))
    ).toBeNull()
    const noPid = evidence({
      expected: { distroInstance: INSTANCE, kingud: null },
      identity: { distroInstance: INSTANCE, kingud: null }
    })
    expect(nextWslLivenessProbe(noPid)).toBe('kingud-port')
    expect(nextWslLivenessProbe({ ...noPid, kingudPort: 'refused' })).toBeNull()
    expect(
      nextWslLivenessProbe({ ...noPid, identity: { distroInstance: 'other', kingud: null } })
    ).toBeNull()
  })
})
