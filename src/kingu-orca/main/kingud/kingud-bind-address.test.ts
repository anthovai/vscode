import { describe, expect, it } from 'vitest'
import {
  bindHostIsNetworkExposed,
  describeKingudBindExposure,
  KINGUD_LOOPBACK_BIND_HOST,
  KingudBindAddressError,
  resolveKingudBindHost
} from './kingud-bind-address'

describe('resolveKingudBindHost', () => {
  it('defaults to loopback when the operator asked for nothing', () => {
    expect(resolveKingudBindHost()).toBe(KINGUD_LOOPBACK_BIND_HOST)
    expect(KINGUD_LOOPBACK_BIND_HOST).toBe('127.0.0.1')
  })

  it('accepts literal IPv4 and IPv6 addresses, including explicit wide binds', () => {
    expect(resolveKingudBindHost('0.0.0.0')).toBe('0.0.0.0')
    expect(resolveKingudBindHost('10.1.2.3')).toBe('10.1.2.3')
    expect(resolveKingudBindHost('::1')).toBe('::1')
    expect(resolveKingudBindHost('localhost')).toBe('127.0.0.1')
    expect(resolveKingudBindHost(' 127.0.0.1 ')).toBe('127.0.0.1')
  })

  it('refuses hostnames, because DNS would decide which interface got bound', () => {
    expect(() => resolveKingudBindHost('internal.example')).toThrow(KingudBindAddressError)
    expect(() => resolveKingudBindHost('')).toThrow(KingudBindAddressError)
    expect(() => resolveKingudBindHost('0.0.0.0:80')).toThrow(KingudBindAddressError)
  })
})

describe('bindHostIsNetworkExposed', () => {
  it('separates local-only addresses from network-reachable ones', () => {
    expect(bindHostIsNetworkExposed('127.0.0.1')).toBe(false)
    expect(bindHostIsNetworkExposed('127.5.5.5')).toBe(false)
    expect(bindHostIsNetworkExposed('::1')).toBe(false)
    expect(bindHostIsNetworkExposed('0.0.0.0')).toBe(true)
    expect(bindHostIsNetworkExposed('::')).toBe(true)
    expect(bindHostIsNetworkExposed('10.1.2.3')).toBe(true)
  })

  it('says out loud when a deployment is reachable from the network', () => {
    expect(describeKingudBindExposure('0.0.0.0')).toContain('reachable from the network')
    expect(describeKingudBindExposure('127.0.0.1')).toContain('local only')
  })
})
