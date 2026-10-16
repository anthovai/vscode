import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { KINGUD_SERVER_ENTRY_FILENAME } from '../../shared/kingud-artifacts'
import { assertKingudServerRuntime, handoffToBundledKingud } from './kingud-bundled-runtime'
import { KINGUD_EXIT_CONFIGURATION } from './kingud-configuration-exit'
import { enableManagedKingudCompileCache } from './kingud-compile-cache'

declare const KINGUD_SERVER_SHA256: string

let loadServer: (() => void) | undefined

try {
  if (!handoffToBundledKingud()) {
    assertKingudServerRuntime()
    const entry = realpathSync(process.argv[1] ?? __filename)
    const server = join(dirname(entry), KINGUD_SERVER_ENTRY_FILENAME)
    if (createHash('sha256').update(readFileSync(server)).digest('hex') !== KINGUD_SERVER_SHA256) {
      throw new Error('The Kingu server does not match its launcher')
    }
    loadServer = () => {
      enableManagedKingudCompileCache(dirname(entry))
      createRequire(entry)(server)
    }
  }
} catch (error) {
  console.error('kingud: failed to launch:', error)
  process.exit(KINGUD_EXIT_CONFIGURATION)
}

loadServer?.()
