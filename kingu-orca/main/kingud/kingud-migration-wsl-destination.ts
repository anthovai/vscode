/**
 * Only the kingud an Kingu desktop launched inside a distro may receive that distro's projects: the
 * move keeps every file where it is, so any other host would own paths it cannot see.
 */
import type { KingudMigrationManifestSource } from '../../shared/kingud-migration-manifest'
import { isKingudMigrationLocalWslSource } from '../../shared/kingud-migration-source-kind'
import { isWslHostKingudProcess } from '../ipc/wsl-guest-windows-drive-path'

export const KINGUD_MIGRATION_SOURCE_NOT_THIS_HOST = 'kingud_migration_source_not_this_host'

/** The distro's registry id, which the desktop passes at launch (D1b-4); the guest cannot read it. */
export const KINGUD_WSL_DISTRO_GUID_ENV = 'KINGU_WSL_DISTRO_GUID'

/** True on the kingud of a WSL host, which is the only host that advertises the WSL source kind. */
export function servesLocalWslMigrationSource(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return isWslHostKingudProcess(env, platform)
}

export function assertKingudMigrationSourceServedHere(
  source: KingudMigrationManifestSource,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): void {
  if (!isKingudMigrationLocalWslSource(source)) {
    return
  }
  // WSL treats distro names case-insensitively, and so does every UNC path to one.
  const distro = env.WSL_DISTRO_NAME?.trim().toLowerCase()
  if (!servesLocalWslMigrationSource(env, platform) || distro !== source.distro.toLowerCase()) {
    throw new Error(KINGUD_MIGRATION_SOURCE_NOT_THIS_HOST)
  }
  // A re-registered distro reuses the name but not the files. Unknown here fails closed.
  const guid = env[KINGUD_WSL_DISTRO_GUID_ENV]?.trim().toLowerCase()
  if (source.distroGuid !== undefined && guid !== source.distroGuid.toLowerCase()) {
    throw new Error(KINGUD_MIGRATION_SOURCE_NOT_THIS_HOST)
  }
}
