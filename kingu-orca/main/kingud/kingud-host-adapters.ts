/** The Node host's stand-ins for Electron's app environment and secret store. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { KINGUD_CLI_PACKAGE_FILENAME } from '../../shared/kingud-artifacts'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore, type SecretStore } from '../../shared/secret-store'
import { resolveKingudInstallRoot, resolveKingudPath } from './kingud-app-paths'
import { getKingudCliLauncherPath } from './kingud-cli-launcher'
import { describeKingudSecretProtectionGap } from './kingud-secret-protection-gap'

let quitRegisteredHandlers = (): void => {}

export function runKingudQuitHandlers(): void {
  quitRegisteredHandlers()
}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  quitRegisteredHandlers = (): void => {
    const errors: unknown[] = []
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }
    // Why throw: a quit handler that failed may leave a writer running, which keeps the lock.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'kingud_quit_handlers_failed')
    }
  }
  return {
    getPath: resolveKingudPath,
    getAppPath: () => resolveKingudInstallRoot(),
    getVersion: () => process.env.KINGU_VERSION ?? '0.0.0-kingud',
    // Why still true: consumers read this as "production build, not a dev checkout" —
    // it gates HTTPS-only skill downloads, the real CLI command name, and shell-PATH
    // hydration. Answering false to satisfy a path resolver would relax a security
    // posture. Layout questions must ask whether the app root is an asar archive
    // instead (see parcel-watcher-entry-path.ts).
    isPackaged: () => true,
    getCliLauncherPath: getKingudCliLauncherPath,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: (code = 0) => process.exit(code),
    // Why []: there are no Chromium processes on this host to measure.
    getAppMetrics: () => []
  }
}

/**
 * Why not silently plaintext: `isEncryptionAvailable() === false` already makes every
 * caller fall back to unsealed storage, which is a security posture, not a detail.
 * `describeProtectionGap()` gives the reason a client can surface.
 */
function createNodeSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('kingud_secret_sealing_unavailable')
    },
    decryptString: () => {
      throw new Error('kingud_secret_sealing_unavailable')
    },
    describeProtectionGap: () => describeKingudSecretProtectionGap(process.platform)
  }
}

/**
 * The Kingu release this server was built from, stamped into the bundle's own `out/package.json`.
 * Why: `status.get` and the updater report KINGU_APP_VERSION, which only the desktop's preflight
 * sets, so a server read `0.0.0-dev`. The bundle wins over an inherited value from another build.
 */
export function stampKingudAppVersion(installRoot: () => string = resolveKingudInstallRoot): void {
  let version: unknown
  try {
    const path = join(installRoot(), ...KINGUD_CLI_PACKAGE_FILENAME.split('/'))
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    version = parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : null
  } catch {
    return
  }
  if (typeof version === 'string' && version.length > 0) {
    process.env.KINGU_APP_VERSION = version
  }
}

export function installKingudHostAdapters(): void {
  stampKingudAppVersion()
  setAppEnvironment(createNodeAppEnvironment())
  setSecretStore(createNodeSecretStore())
}
