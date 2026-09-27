import { describe, expect, it } from 'vitest'
import {
  KINGU_SESSION_ADDRESS_PREFIX,
  formatKinguSessionAddress,
  isKinguSessionId,
  parseKinguSessionAddress
} from './kingu-session-address'
import { testKinguSessionId } from './kingu-session-address-test-fixture'

const SESSION_ID = testKinguSessionId('0b7e4c2a-5f1d-4e8a-9c3b-2d6f8a1e4b70')
const ADDRESS = `session:${SESSION_ID}`

describe('Kingu session address', () => {
  it('addresses an Kingu session id as session:<id> and parses the bare id back', () => {
    expect(KINGU_SESSION_ADDRESS_PREFIX).toBe('session:')
    expect(formatKinguSessionAddress(SESSION_ID)).toBe(ADDRESS)
    expect(parseKinguSessionAddress(ADDRESS)).toBe(SESSION_ID)
    const parsed = parseKinguSessionAddress(ADDRESS)
    expect(parsed && formatKinguSessionAddress(parsed)).toBe(ADDRESS)
  })

  it('reads only the addressed spelling when parsing an address', () => {
    // A bare id is what the columns store, not an address.
    expect(parseKinguSessionAddress(SESSION_ID)).toBeNull()
    expect(parseKinguSessionAddress(null)).toBeNull()
    expect(parseKinguSessionAddress(undefined)).toBeNull()
    expect(parseKinguSessionAddress('')).toBeNull()
  })

  it.each([
    ['an unknown prefix', `pane:${SESSION_ID}`],
    ['the Run mailbox namespace', 'run:run_123'],
    ['the Dispatch mailbox namespace', 'dispatch:ctx_123'],
    ['an empty prefix', `:${SESSION_ID}`],
    ['an empty id', 'session:'],
    ['an id with a separator', `session:${SESSION_ID}:extra`],
    ['an id the session predicate rejects', 'session:short'],
    ['a terminal handle', 'term_4f2c9a']
  ])('refuses %s', (_label, value) => {
    expect(parseKinguSessionAddress(value)).toBeNull()
  })

  it.each([
    ['a PTY terminal handle', 'term_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c'],
    ['a short PTY terminal handle', 'term_4f2c9a'],
    ['a structured-worker handle', 'structworker_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c']
  ])('never treats %s as an Kingu session id', (_label, handle) => {
    // Handles share the session-id charset, so the session-record predicate alone would accept them.
    expect(isKinguSessionId(handle)).toBe(false)
    expect(parseKinguSessionAddress(`session:${handle}`)).toBeNull()
  })

  it('validates an Kingu session id with the session-record predicate', () => {
    expect(isKinguSessionId(SESSION_ID)).toBe(true)
    expect(isKinguSessionId('has space in it')).toBe(false)
    expect(isKinguSessionId('x'.repeat(129))).toBe(false)
  })
})
