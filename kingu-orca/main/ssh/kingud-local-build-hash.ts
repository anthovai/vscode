/** Shares the host build identity so activation verifies the shipped entry bytes. */
import { join } from 'node:path'
import { hashKingudLauncher } from '../../shared/kingud-build-identity'
import { KINGUD_LAUNCHER_FILENAME } from '../../shared/kingud-artifacts'

export { KINGUD_BUILD_HASH_LENGTH } from '../../shared/kingud-build-identity'

export function computeLocalKingudBuildHash(localKingudDir: string): string {
  return hashKingudLauncher(join(localKingudDir, KINGUD_LAUNCHER_FILENAME))
}
