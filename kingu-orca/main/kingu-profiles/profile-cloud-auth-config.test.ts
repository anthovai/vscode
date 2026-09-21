import { describe, expect, it, vi } from 'vitest'
import {
  allowsPlaintextKinguCloudSession,
  getKinguCloudAuthConfig,
  isKinguCloudDevAuthEnabled
} from './profile-cloud-auth-config'

vi.mock('electron', () => ({
  app: {
    isPackaged: false
  }
}))

describe('Kingu cloud auth config', () => {
  it('reports unconfigured without both API URL and client ID', () => {
    expect(getKinguCloudAuthConfig({})).toEqual({
      configured: false,
      setupMessage: 'Kingu Cloud sign-in is not configured for this build.'
    })
  })

  it('builds default desktop auth endpoints from the API URL', () => {
    const state = getKinguCloudAuthConfig({
      KINGU_CLOUD_API_URL: 'https://kingu-cloud.example/',
      KINGU_CLOUD_CLIENT_ID: 'desktop-client'
    })

    expect(state).toEqual({
      configured: true,
      config: {
        apiBaseUrl: 'https://kingu-cloud.example',
        authorizeEndpoint: 'https://kingu-cloud.example/v1/desktop/auth/authorize',
        sessionEndpoint: 'https://kingu-cloud.example/v1/desktop/auth/session',
        refreshEndpoint: 'https://kingu-cloud.example/v1/desktop/auth/refresh',
        capabilitiesEndpoint: 'https://kingu-cloud.example/v1/desktop/auth/capabilities',
        profileEndpoint: 'https://kingu-cloud.example/v1/desktop/auth/profile',
        orgEndpoint: 'https://kingu-cloud.example/v1/desktop/auth/org',
        logoutEndpoint: 'https://kingu-cloud.example/v1/desktop/auth/logout',
        relayTokenEndpoint: 'https://kingu-cloud.example/v1/desktop/auth/relay-token',
        relayDirectorUrl: 'https://relay.onkingu.dev',
        clientId: 'desktop-client',
        scope: 'openid profile email offline_access'
      }
    })
  })

  it('uses first-party production endpoints without runtime env in packaged builds', () => {
    expect(getKinguCloudAuthConfig({}, true)).toEqual({
      configured: true,
      config: {
        apiBaseUrl: 'https://login.onkingu.dev',
        authorizeEndpoint: 'https://login.onkingu.dev/v1/desktop/auth/authorize',
        sessionEndpoint: 'https://login.onkingu.dev/v1/desktop/auth/session',
        refreshEndpoint: 'https://login.onkingu.dev/v1/desktop/auth/refresh',
        capabilitiesEndpoint: 'https://login.onkingu.dev/v1/desktop/auth/capabilities',
        profileEndpoint: 'https://login.onkingu.dev/v1/desktop/auth/profile',
        orgEndpoint: 'https://login.onkingu.dev/v1/desktop/auth/org',
        logoutEndpoint: 'https://login.onkingu.dev/v1/desktop/auth/logout',
        relayTokenEndpoint: 'https://login.onkingu.dev/v1/desktop/auth/relay-token',
        relayDirectorUrl: 'https://relay.onkingu.dev',
        clientId: 'kingu-desktop',
        scope: 'openid profile email offline_access'
      }
    })
  })

  it('allows loopback HTTP endpoints for local desktop auth development', () => {
    const state = getKinguCloudAuthConfig({
      KINGU_CLOUD_API_URL: 'http://localhost:4100',
      KINGU_CLOUD_CLIENT_ID: 'desktop-client'
    })

    expect(state.configured).toBe(true)
  })

  it('rejects loopback HTTP endpoints in packaged builds', () => {
    expect(
      getKinguCloudAuthConfig(
        {
          KINGU_CLOUD_API_URL: 'http://localhost:4100',
          KINGU_CLOUD_CLIENT_ID: 'desktop-client'
        },
        true
      )
    ).toMatchObject({ configured: false })

    const httpsState = getKinguCloudAuthConfig(
      {
        KINGU_CLOUD_API_URL: 'https://kingu-cloud.example',
        KINGU_CLOUD_CLIENT_ID: 'desktop-client'
      },
      true
    )
    expect(httpsState.configured).toBe(true)
  })

  it('rejects non-HTTPS non-loopback API URLs', () => {
    expect(
      getKinguCloudAuthConfig({
        KINGU_CLOUD_API_URL: 'http://kingu-cloud.example',
        KINGU_CLOUD_CLIENT_ID: 'desktop-client'
      })
    ).toMatchObject({ configured: false })
  })

  it('allows dev plaintext sessions only outside production', () => {
    expect(
      allowsPlaintextKinguCloudSession({
        KINGU_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
    expect(
      allowsPlaintextKinguCloudSession({
        KINGU_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
  })

  it('ignores dev flags in packaged builds even without NODE_ENV', () => {
    // Why: packaged main bundles never define NODE_ENV, so packaged-ness must
    // gate the escape hatches on its own.
    expect(
      allowsPlaintextKinguCloudSession({ KINGU_CLOUD_ALLOW_PLAINTEXT_SESSION: '1' }, true)
    ).toBe(false)
    expect(isKinguCloudDevAuthEnabled({ KINGU_CLOUD_DEV_AUTH: '1' }, true)).toBe(false)
  })

  it('allows local dev auth only outside production', () => {
    expect(
      isKinguCloudDevAuthEnabled({
        KINGU_CLOUD_DEV_AUTH: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
    expect(
      isKinguCloudDevAuthEnabled({
        KINGU_CLOUD_DEV_AUTH: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
  })
})
