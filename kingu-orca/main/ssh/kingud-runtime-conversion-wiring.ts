/** The live collaborators a host conversion needs: the census, the direct session and the server. */
import { encodePairingOffer } from '../../shared/pairing'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { disconnectRegisteredSshTarget } from '../ipc/ssh-session-teardown'
import type { KingudMigrationDestinationCatalog } from './kingud-migration-cutover-coordinator'
import {
  abortRemoteKingudMigrationCatalog,
  commitRemoteKingudMigrationCatalog,
  listRemoteKingudRepositories,
  readRemoteKingudMigrationCatalogState,
  stageRemoteKingudMigrationCatalog,
  stageRemoteKingudMigrationSnapshotChunk
} from './kingud-migration-catalog-client'
import { censusHostRelayTerminalsFor } from './ssh-host-relay-census-for-target'
import type { KingudManagedConversionArgs } from './kingud-runtime-conversion'
import type { KingudServerRepository } from './kingud-migration-repository-link'

/** The T6-9 client against this server, pinned to the runtime it paired with. */
export function kingudMigrationDestinationFor(
  environment: KnownRuntimeEnvironment
): KingudMigrationDestinationCatalog {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  return {
    readState: (manifest) => readRemoteKingudMigrationCatalogState(pairingCode, manifest, options),
    stage: (manifest) => stageRemoteKingudMigrationCatalog(pairingCode, manifest, options),
    commit: (manifest) => commitRemoteKingudMigrationCatalog(pairingCode, manifest, options),
    abort: (manifest) => abortRemoteKingudMigrationCatalog(pairingCode, manifest, options),
    stageChunk: (request) => stageRemoteKingudMigrationSnapshotChunk(pairingCode, request, options)
  }
}

/** The projects this server already holds, read through the same pinned pairing. */
export function kingudServerRepositoriesFor(
  environment: KnownRuntimeEnvironment
): Promise<KingudServerRepository[]> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteKingudRepositories(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

export function conversionCollaborators(): Pick<
  KingudManagedConversionArgs,
  'destinationFor' | 'serverRepositoriesFor' | 'censusHost' | 'releaseDirectSession'
> {
  return {
    destinationFor: kingudMigrationDestinationFor,
    serverRepositoriesFor: kingudServerRepositoriesFor,
    censusHost: (target) => censusHostRelayTerminalsFor(target)(),
    releaseDirectSession: disconnectRegisteredSshTarget
  }
}
