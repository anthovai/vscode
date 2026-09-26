import { isPackagedKinguHostBuild, isTrustedKinguCloudHost } from '../kingu-host-build'

const PRODUCTION_ARTIFACTS_API_URL = 'https://share.onkingu.dev'

function isPackaged(): boolean {
  return isPackagedKinguHostBuild()
}

export function resolveArtifactCloudApiUrl(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackaged()
): string {
  const candidate = override?.trim() || env.KINGU_ARTIFACTS_API_URL?.trim()
  const url = new URL(candidate || PRODUCTION_ARTIFACTS_API_URL)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const firstParty = isTrustedKinguCloudHost(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !packaged)) {
    throw new Error('Artifact API URLs must use HTTPS; local development may use loopback HTTP.')
  }
  if (!firstParty && !loopback) {
    throw new Error('Artifact API URLs must use an onkingu.dev or loopback host.')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Artifact API URL must be an origin without credentials, paths, or parameters.')
  }
  return url.origin
}

export function allowsArtifactCloudAuthOverride(
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackaged()
): boolean {
  return env.NODE_ENV !== 'production' && !packaged
}
