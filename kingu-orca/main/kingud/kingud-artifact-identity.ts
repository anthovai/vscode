import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  KINGUD_SERVER_TARGET_FILENAME,
  KINGUD_VERSION,
  kingudArtifactFilenames
} from '../../shared/kingud-artifacts'
import { COMPAT_SERVER_TARGETS, SERVER_TARGETS } from '../../shared/node-runtime-pin'
import { kingudAgentBrowserNativeName } from '../../shared/kingud-agent-browser-name'

/** Hash installed bytes in the build's order; a version marker is not proof of delivery. */
export async function readKingudArtifactIdentity(directory: string): Promise<string> {
  const target = z
    .enum([...SERVER_TARGETS, ...COMPAT_SERVER_TARGETS])
    .parse((await readFile(join(directory, KINGUD_SERVER_TARGET_FILENAME), 'utf8')).trim())
  const platform = target.startsWith('win32-')
    ? 'win32'
    : target.startsWith('darwin-')
      ? 'darwin'
      : 'linux'
  const browser = kingudAgentBrowserNativeName(
    platform,
    target.split('-')[1] ?? '',
    target.endsWith('-musl') ? 'musl' : 'glibc'
  )
  const filenames = kingudArtifactFilenames(target)
  if (existsSync(join(directory, browser))) {
    filenames.push(browser)
  }
  const hash = createHash('sha256')
  for (const filename of filenames) {
    for await (const chunk of createReadStream(join(directory, filename))) {
      hash.update(chunk)
    }
  }
  return `${KINGUD_VERSION}+${hash.digest('hex').slice(0, 12)}`
}
