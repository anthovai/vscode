import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KingudMigrationBlobDescriptor } from '../shared/kingud-migration-blob-transfer'
import type { KingudMigrationManifest } from '../shared/kingud-migration-manifest'
import { getKingudMigrationReceivedBlobPath } from './persistence/migrating-kingud-catalog/kingud-migration-blob-staging'
import { buildWslMoveRestoreHintsBlob } from './persistence/moving-wsl-projects/wsl-move-restore-hints-blob'
import {
  commitStagedKingudMigrationCatalogDurably,
  getKingudMigrationCatalogState
} from './runtime/kingud-migration-catalog-import'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import {
  DORMANT_LEAF_ID,
  DORMANT_WORKTREE_ID,
  FOLDER_WORKSPACE,
  REPOSITORY,
  dormantState,
  manifest as baseManifest
} from './persistence-kingud-migration-catalog-fixture'
import { createStore, testState } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

const FOLDER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE = `tab-dormant:${DORMANT_LEAF_ID}`
const OTHER_PANE = `tab-folder:${FOLDER_LEAF_ID}`
const ABSENT_PANE = 'tab-absent:33333333-3333-4333-8333-333333333333'
const FOLDER_KEY = folderWorkspaceKey(FOLDER_WORKSPACE.id)

type Store = ReturnType<typeof createStore>

// The moved session owns PANE in the dormant worktree and OTHER_PANE in the folder workspace.
function manifest(): KingudMigrationManifest {
  const dormant = dormantState()
  const session = dormant.workspaceSession!
  dormant.workspaceSession = {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [FOLDER_KEY]: [
        {
          id: 'tab-folder',
          ptyId: null,
          worktreeId: FOLDER_KEY,
          title: 'Folder terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 8
        }
      ]
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      'tab-folder': {
        root: { type: 'leaf', leafId: FOLDER_LEAF_ID },
        activeLeafId: FOLDER_LEAF_ID,
        expandedLeafId: null
      }
    }
  }
  const base = baseManifest()
  return baseManifest({ payload: { ...base.payload, dormantState: dormant } })
}

function peek(store: Store, paneKey: string, worktreeId: string): string | null {
  return store.peekKingudMigrationTerminalRestoreHint(paneKey, worktreeId)
}

function encodedHints(): {
  descriptor: KingudMigrationBlobDescriptor
  bytes: Buffer
} {
  const blob = buildWslMoveRestoreHintsBlob([
    { paneKey: PANE, cwd: '/home/me/src' },
    { paneKey: OTHER_PANE, cwd: '/srv/app' },
    { paneKey: ABSENT_PANE, cwd: '/srv/gone' }
  ])
  if (!blob) {
    throw new Error('expected a hints blob')
  }
  return blob
}

function rawBlob(bytes: Buffer): {
  descriptor: KingudMigrationBlobDescriptor
  bytes: Buffer
} {
  return {
    bytes,
    descriptor: {
      blobKind: 'terminal-restore-hints',
      key: 'migration',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    }
  }
}

function stageBlob(
  store: Store,
  input: KingudMigrationManifest,
  blob: { descriptor: KingudMigrationBlobDescriptor; bytes: Buffer }
): void {
  store.stageKingudMigrationCatalog(input)
  store.stageKingudMigrationBlobChunk({
    migrationId: input.migrationId,
    manifestSha256: input.manifestSha256,
    blob: blob.descriptor,
    offset: 0,
    bytesBase64: blob.bytes.toString('base64')
  })
}

function receivedPath(input: KingudMigrationManifest): string {
  return getKingudMigrationReceivedBlobPath(join(testState.dir, 'kingud-migration-blobs'), input, {
    blobKind: 'terminal-restore-hints',
    key: 'migration'
  })
}

async function commitDurably(store: Store, input: KingudMigrationManifest): Promise<string> {
  const result = await commitStagedKingudMigrationCatalogDurably({
    store,
    manifest: input,
    onDurableCommit: () => {}
  })
  return result.state
}

describe('kingud migration terminal restore hints through the store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'kingu-migration-restore-hints-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('installs hints scoped to their worktree after the durable commit, and survives a restart', async () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, encodedHints())

    expect(await commitDurably(store, input)).toBe('committed')
    expect(existsSync(receivedPath(input))).toBe(false)

    const restarted = createStore()
    expect(peek(restarted, PANE, DORMANT_WORKTREE_ID)).toBe('/home/me/src')
    expect(peek(restarted, PANE, FOLDER_KEY)).toBeNull()
    expect(peek(restarted, OTHER_PANE, FOLDER_KEY)).toBe('/srv/app')
    // A pane the moved session does not hold has no worktree to scope it to.
    expect(peek(restarted, ABSENT_PANE, DORMANT_WORKTREE_ID)).toBeNull()
    restarted.consumeKingudMigrationTerminalRestoreHint(PANE)
    expect(peek(createStore(), PANE, DORMANT_WORKTREE_ID)).toBeNull()
    expect(peek(createStore(), OTHER_PANE, FOLDER_KEY)).toBe('/srv/app')
  })

  it('is idempotent across commit retries and never revives a consumed hint', async () => {
    const input = manifest()
    const store = createStore()
    const blob = encodedHints()
    stageBlob(store, input, blob)
    store.commitStagedKingudMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    // A crash after install but before the blob was deleted leaves it in place.
    store.installKingudMigrationReceivedBlobs(input)
    expect(peek(store, PANE, DORMANT_WORKTREE_ID)).toBe('/home/me/src')
    store.consumeKingudMigrationTerminalRestoreHint(PANE)
    writeFileSync(receivedPath(input), blob.bytes)

    expect(await commitDurably(createStore(), input)).toBe('committed')
    expect(existsSync(receivedPath(input))).toBe(false)
    const restarted = createStore()
    expect(peek(restarted, PANE, DORMANT_WORKTREE_ID)).toBeNull()
    expect(peek(restarted, OTHER_PANE, FOLDER_KEY)).toBe('/srv/app')
  })

  it('retries a failed install on the next store load', async () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, encodedHints())
    const installed = join(testState.dir, 'kingud-migration-blobs', 'installed')
    // A file where the hint store's directory belongs makes the install's write fail.
    writeFileSync(installed, '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await commitDurably(store, input)).toBe('committed')
    expect(error).toHaveBeenCalledWith(
      '[kingud-migration] installing received blobs failed:',
      expect.any(Error)
    )
    expect(existsSync(receivedPath(input))).toBe(true)
    error.mockRestore()

    rmSync(installed)
    mkdirSync(installed)
    const restarted = createStore()
    expect(existsSync(receivedPath(input))).toBe(false)
    expect(peek(restarted, PANE, DORMANT_WORKTREE_ID)).toBe('/home/me/src')
  })

  it('retries a failed install when the committed catalog state is queried', async () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, encodedHints())
    const installed = join(testState.dir, 'kingud-migration-blobs', 'installed')
    writeFileSync(installed, '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await commitDurably(store, input)).toBe('committed')
    error.mockRestore()

    rmSync(installed)
    expect(getKingudMigrationCatalogState({ store, manifest: input }).state).toBe('committed')
    expect(existsSync(receivedPath(input))).toBe(false)
    expect(peek(store, PANE, DORMANT_WORKTREE_ID)).toBe('/home/me/src')
  })

  it("drops a removed project's hints and keeps the others", async () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, encodedHints())
    expect(await commitDurably(store, input)).toBe('committed')

    store.removeProjectForHost(REPOSITORY.id, 'local')
    expect(peek(store, PANE, DORMANT_WORKTREE_ID)).toBeNull()
    expect(peek(store, OTHER_PANE, FOLDER_KEY)).toBe('/srv/app')

    expect(store.removeFolderWorkspace(FOLDER_WORKSPACE.id)).toBe(true)
    expect(peek(createStore(), OTHER_PANE, FOLDER_KEY)).toBeNull()
  })

  it('installs nothing for a catalog that is only staged', () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, encodedHints())
    store.installKingudMigrationReceivedBlobs(input)
    expect(peek(store, PANE, DORMANT_WORKTREE_ID)).toBeNull()
  })

  it('refuses to commit a digest-exact blob that is not a hints document', () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, rawBlob(Buffer.from('{"version":1,"hints":[{"paneKey":"x"}]}')))

    expect(() => store.commitStagedKingudMigrationCatalog(input)).toThrow(
      /^kingud_migration_blob_content_invalid:terminal-restore-hints:/
    )
    expect(store.getKingudMigrationCatalogState(input).state).toBe('staged')
  })

  it('drops a received file damaged after commit without failing the committed catalog', async () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, encodedHints())
    store.commitStagedKingudMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    writeFileSync(receivedPath(input), 'not json')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await commitDurably(createStore(), input)).toBe('committed')
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('dropped unreadable terminal restore hints'),
      expect.any(Error)
    )
    expect(existsSync(receivedPath(input))).toBe(false)
    expect(peek(createStore(), PANE, DORMANT_WORKTREE_ID)).toBeNull()
    error.mockRestore()
  })
})
