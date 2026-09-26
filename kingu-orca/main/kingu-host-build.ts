import { app } from 'electron'

// Why: Kingu runs this main process inside its own executable, and Electron
// reports `isPackaged` from the executable's name, so a Kingu build run from
// sources looks packaged. Kingu says so explicitly instead; the cloud checks
// below read this rather than `app.isPackaged`.
export function isPackagedKinguHostBuild(): boolean {
  if (process.env.KINGU_HOST_UNPACKAGED === '1') {
    return false
  }
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

// Why: skill packages download from GCS signed URLs; a self-hosted cloud serves
// its own grants from the API origin, and development may add loopback origins.
export function kinguSkillDownloadOrigins(allowConfiguredOrigins: boolean): string[] {
  const origins = ['https://storage.googleapis.com']
  const api = process.env.KINGU_ARTIFACTS_API_URL?.trim()
  if (api) {
    try {
      const url = new URL(api)
      if (url.protocol === 'https:' && isTrustedKinguCloudHost(url.hostname)) {
        origins.push(url.origin)
      }
    } catch {
      // Not a URL; the artifact config reports it.
    }
  }
  if (allowConfiguredOrigins && process.env.KINGU_SKILL_PACKAGE_DOWNLOAD_ORIGINS) {
    origins.push(
      ...process.env.KINGU_SKILL_PACKAGE_DOWNLOAD_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
  }
  return [...new Set(origins)]
}

// Why: the cloud checks accept only the first-party domain; a self-hosted
// cloud names its own host (Kingu fills this from KINGU_CLOUD_URL).
export function isTrustedKinguCloudHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'onkingu.dev' || host.endsWith('.onkingu.dev')) {
    return true
  }
  return (process.env.KINGU_CLOUD_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry !== '' && (host === entry || host.endsWith(`.${entry}`)))
}
