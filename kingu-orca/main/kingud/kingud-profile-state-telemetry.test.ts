import { describe, expect, it, vi } from 'vitest'
import {
  emitKingudProfileStateAuthoritySelected,
  formatKingudProfileStateAuthoritySelected,
  type KingudProfileStateAuthoritySelection
} from './kingud-profile-state-telemetry'

const selection: KingudProfileStateAuthoritySelection = {
  backend: 'sqlite',
  classification: 'json-only',
  authority_mode: 'sqlite-established',
  runtime: 'kingud',
  migrated: true
}

describe('kingud profile-state telemetry', () => {
  it('formats a bounded machine-readable authority selection event', () => {
    expect(JSON.parse(formatKingudProfileStateAuthoritySelected(selection).slice(18))).toEqual({
      event: 'profile_state_authority_selected',
      ...selection
    })
  })

  it('strips unexpected runtime fields before writing the record', () => {
    const selectionWithRuntimeFields = Object.assign({}, selection, {
      database_path: '/private/profile-state.db'
    })
    const line = formatKingudProfileStateAuthoritySelected(selectionWithRuntimeFields)
    expect(line).not.toContain('database_path')
  })

  it('sends the event to the supplied sink', () => {
    const sink = vi.fn()
    emitKingudProfileStateAuthoritySelected(selection, sink)
    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith(formatKingudProfileStateAuthoritySelected(selection))
  })

  it('never lets a failing sink block startup', () => {
    expect(() =>
      emitKingudProfileStateAuthoritySelected(selection, () => {
        throw new Error('closed stderr')
      })
    ).not.toThrow()
  })
})
