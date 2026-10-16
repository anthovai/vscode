import { describe, expect, it } from 'vitest'
import {
  classifyKingudHostUnavailable,
  kingudCandidateLaunchFailureCode
} from './kingud-host-unavailable'
import { KingudWindowsLaunchRefusedError } from '../ssh/kingud-remote-launch-windows'
import { KingudWindowsCommandLineError } from '../ssh/kingud-remote-windows-node'

describe('classifyKingudHostUnavailable', () => {
  it('sends a Windows host that cannot launch kingud back to the relay', () => {
    const refused = new KingudWindowsLaunchRefusedError('breakaway denied')
    const unsafe = new KingudWindowsCommandLineError('C:\\Users\\%x%')
    expect(classifyKingudHostUnavailable(refused)).toBe('unsupported_host')
    expect(classifyKingudHostUnavailable(unsafe)).toBe('unsupported_host')
    expect(classifyKingudHostUnavailable({ code: refused.code })).toBe('unsupported_host')
    expect(classifyKingudHostUnavailable({ code: unsafe.code })).toBe('unsupported_host')
  })

  it('keeps an ordinary launch failure retryable', () => {
    expect(kingudCandidateLaunchFailureCode(new Error('spawn failed'))).toBe(
      'kingud_candidate_launch_failed'
    )
    expect(
      classifyKingudHostUnavailable({
        code: kingudCandidateLaunchFailureCode(new Error('spawn failed'))
      })
    ).toBeNull()
    expect(kingudCandidateLaunchFailureCode(new KingudWindowsLaunchRefusedError('x'))).toBe(
      'kingud_windows_launch_refused'
    )
  })
})
