import { parsePairingCode, type PairingOffer } from './pairing'
import {
  createEnvironmentFromPairingOffer,
  getPreferredLoopbackRuntimePort,
  getKingudSshDeployment,
  getPreferredPairingOffer,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment,
  type KingudSshDeploymentLink
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import {
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import { resolveEnvironmentFromStore } from './runtime-environment-store'

/** Registers a server Kingu deployed over SSH, paired through its own loopback tunnel. */
export function addManagedKingudEnvironment(
  userDataPath: string,
  args: {
    id: string
    name: string
    pairingCode: string
    kingudDeployment: KingudSshDeploymentLink
    now?: number
  }
): KnownRuntimeEnvironment {
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid managed pairing code.')
  }
  const known = readEnvironmentStore(userDataPath).environments
  if (known.some((entry) => entry.id === args.id)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server with id "${args.id}" already exists.`
    )
  }
  if (known.some((entry) => entry.name === args.name)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server named "${args.name}" already exists.`
    )
  }
  const environment = createEnvironmentFromPairingOffer({
    id: args.id,
    name: args.name,
    now: args.now ?? Date.now(),
    offer,
    runtimeId: null,
    connectionDependency: 'ssh-tunnel'
  })
  if (getPreferredLoopbackRuntimePort(environment) !== args.kingudDeployment.localPort) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The managed pairing does not point at its SSH tunnel.'
    )
  }
  const persisted = PersistedRuntimeEnvironmentSchema.parse(environment)
  const environments = [
    ...readPersistedEnvironmentStore(userDataPath).environments,
    persisted
  ].sort((a, b) => a.name.localeCompare(b.name))
  // Sidecar first: a crash between the writes leaves an ownerless entry the next write prunes,
  // never a registered server that has lost its deployment link.
  writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, persisted, {
    kingudDeployment: args.kingudDeployment
  })
  writeEnvironmentStore(userDataPath, { version: 1, environments })
  const registered = readEnvironmentStore(userDataPath).environments.find(
    (entry) => entry.id === args.id
  )
  if (!registered?.kingudDeployment) {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      'The managed server was saved without its deployment link.'
    )
  }
  return registered
}

/**
 * Unlinks a managed server once its kingud is proven to have exited: drops the persisted entry
 * and the sidecar record that held its deployment link.
 */
export function removeManagedKingudEnvironment(userDataPath: string, environmentId: string): void {
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, environmentId)
  // Throws before the store write when the entry is unreadable, so its link is never orphaned.
  readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  const remaining = store.environments.filter((entry) => entry.id !== persisted.id)
  writeEnvironmentStore(userDataPath, { version: 1, environments: remaining })
  writeRuntimeEnvironmentSidecarEntry(userDataPath, remaining, persisted, null)
}

/** Keeps a managed server's pairing current after its kingud changed versions. */
export function refreshManagedKingudPairing(
  userDataPath: string,
  environmentId: string,
  pairingCode: string,
  now = Date.now()
): KnownRuntimeEnvironment {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid managed pairing code.')
  }
  const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
  if (!current.kingudDeployment) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not managed.')
  }
  const deployment = getKingudSshDeployment(current)
  if (!deployment) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'This server is not managed over SSH.'
    )
  }
  // Why skip: kingud keeps its pairing state across versions, so an unchanged offer needs no
  // rewrite, and every rewrite re-binds the sidecar entry.
  if (samePairing(getPreferredPairingOffer(current), offer)) {
    return current
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, environmentId)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, existing)
  const next = PersistedRuntimeEnvironmentSchema.parse({
    ...createEnvironmentFromPairingOffer({
      id: existing.id,
      name: existing.name,
      now: existing.createdAt,
      offer,
      runtimeId: existing.runtimeId,
      connectionDependency: 'ssh-tunnel'
    }),
    updatedAt: now,
    pairingRevision: Math.max(now, (existing.pairingRevision ?? existing.createdAt) + 1),
    lastUsedAt: existing.lastUsedAt
  })
  if (getPreferredLoopbackRuntimePort(next) !== deployment.localPort) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The managed pairing does not point at its SSH tunnel.'
    )
  }
  const environments = store.environments.map((candidate) =>
    candidate.id === existing.id ? next : candidate
  )
  const { binding: _binding, ...rest } = entry ?? {}
  const state = { ...rest, kingudDeployment: deployment }
  // Why three writes: the entry stays current for both store states, so a failed or interrupted
  // store write can never strand the deployment link.
  writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, existing, state, next)
  writeEnvironmentStore(userDataPath, { version: 1, environments })
  writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, next, state)
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
}

function samePairing(left: PairingOffer, right: PairingOffer): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.deviceToken === right.deviceToken &&
    left.publicKeyB64 === right.publicKeyB64 &&
    left.pairedDeviceId === right.pairedDeviceId
  )
}

/**
 * Marks a managed server as holding migrated state from `at` on. Written before a commit is
 * attempted, so a crash after the commit can never leave a rollback across it unblocked.
 */
export function recordManagedKingudMigration(
  userDataPath: string,
  environmentId: string,
  at: string
): KnownRuntimeEnvironment {
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, environmentId)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  if (!entry?.kingudDeployment) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not managed.')
  }
  const { binding: _binding, ...state } = entry
  // The latest mark wins and never moves back: a snapshot older than any migration, including a
  // later delta move, must stay out of reach.
  const latest =
    state.kingudMigratedAt && Date.parse(state.kingudMigratedAt) >= Date.parse(at)
      ? state.kingudMigratedAt
      : at
  writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, persisted, {
    ...state,
    kingudMigratedAt: latest
  })
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
}
