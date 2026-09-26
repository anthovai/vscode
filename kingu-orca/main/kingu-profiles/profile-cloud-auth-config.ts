import { isPackagedKinguHostBuild } from '../kingu-host-build'
import {
  cleanCloudServiceUrl as cleanUrl,
  cleanCloudServiceOrigin as cleanOrigin
} from '../../shared/cloud-service-url'
import { resolvePushGatewayOrigin } from '../runtime/push/push-gateway-origin'

export type KinguCloudAuthConfig = {
  apiBaseUrl: string
  authorizeEndpoint: string
  sessionEndpoint: string
  refreshEndpoint: string
  capabilitiesEndpoint: string
  profileEndpoint: string
  orgEndpoint: string
  logoutEndpoint: string
  relayTokenEndpoint: string
  relayDirectorUrl: string
  clientId: string
  scope: string
}

const DEFAULT_SCOPE = 'openid profile email offline_access'
const PRODUCTION_API_BASE_URL = 'https://login.onkingu.dev'
const PRODUCTION_CLIENT_ID = 'kingu-desktop'
const PRODUCTION_RELAY_DIRECTOR_URL = 'https://relay.onkingu.dev'

// Why: packaged main bundles never define NODE_ENV, so packaged-ness is the
// only reliable production signal for gating dev-only auth escape hatches.
function isPackagedKinguBuild(): boolean {
  return isPackagedKinguHostBuild()
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString()
}

export function getKinguCloudAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedKinguBuild()
):
  | { configured: true; config: KinguCloudAuthConfig }
  | { configured: false; setupMessage: string } {
  // Why: loopback HTTP endpoints are a local-development convenience only;
  // packaged builds must not accept plain-HTTP token endpoints via env vars.
  const allowLoopbackHttp = !packaged
  const cleanEndpointUrl = (value: string | undefined): string | null =>
    cleanUrl(value, allowLoopbackHttp)
  const configuredApiBaseUrl = env.KINGU_CLOUD_API_URL?.trim()
  // Why: packaged releases cannot depend on launch-time environment injection;
  // these first-party endpoints and the public OAuth client ID are not secrets.
  const apiBaseUrl = configuredApiBaseUrl
    ? cleanEndpointUrl(configuredApiBaseUrl)
    : packaged
      ? PRODUCTION_API_BASE_URL
      : null
  const clientId =
    env.KINGU_CLOUD_CLIENT_ID?.trim() || (packaged ? PRODUCTION_CLIENT_ID : undefined)
  if (!apiBaseUrl || !clientId) {
    return {
      configured: false,
      setupMessage: 'Kingu Cloud sign-in is not configured for this build.'
    }
  }

  const authBaseUrl = cleanEndpointUrl(env.KINGU_CLOUD_AUTH_URL) ?? apiBaseUrl
  return {
    configured: true,
    config: {
      apiBaseUrl,
      authorizeEndpoint:
        cleanEndpointUrl(env.KINGU_CLOUD_AUTHORIZE_URL) ??
        endpoint(authBaseUrl, '/v1/desktop/auth/authorize'),
      sessionEndpoint:
        cleanEndpointUrl(env.KINGU_CLOUD_SESSION_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/session'),
      refreshEndpoint:
        cleanEndpointUrl(env.KINGU_CLOUD_REFRESH_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/refresh'),
      capabilitiesEndpoint:
        cleanEndpointUrl(env.KINGU_CLOUD_CAPABILITIES_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/capabilities'),
      profileEndpoint:
        cleanEndpointUrl(env.KINGU_CLOUD_PROFILE_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/profile'),
      orgEndpoint:
        cleanEndpointUrl(env.KINGU_CLOUD_ORG_URL) ?? endpoint(apiBaseUrl, '/v1/desktop/auth/org'),
      logoutEndpoint:
        cleanEndpointUrl(env.KINGU_CLOUD_LOGOUT_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/logout'),
      relayTokenEndpoint:
        cleanEndpointUrl(env.KINGU_CLOUD_RELAY_TOKEN_URL) ??
        endpoint(apiBaseUrl, '/v1/desktop/auth/relay-token'),
      relayDirectorUrl:
        cleanOrigin(env.KINGU_RELAY_URL, allowLoopbackHttp) ?? PRODUCTION_RELAY_DIRECTOR_URL,
      clientId,
      scope: env.KINGU_CLOUD_AUTH_SCOPE?.trim() || DEFAULT_SCOPE
    }
  }
}

/**
 * Where the host registers phones for background push. Deliberately outside
 * KinguCloudAuthConfig: the push gateway authenticates with the host keypair, so an
 * accountless host reaches it on exactly the same path as a signed-in one.
 */
export function getKinguPushGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedKinguBuild()
): string {
  return resolvePushGatewayOrigin(env, packaged)
}

export function allowsPlaintextKinguCloudSession(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedKinguBuild()
): boolean {
  return (
    env.KINGU_CLOUD_ALLOW_PLAINTEXT_SESSION === '1' && env.NODE_ENV !== 'production' && !packaged
  )
}

export function isKinguCloudDevAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedKinguBuild()
): boolean {
  return env.KINGU_CLOUD_DEV_AUTH === '1' && env.NODE_ENV !== 'production' && !packaged
}
