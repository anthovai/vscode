import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  KINGUD_CLI_ENTRY_FILENAME,
  KINGUD_WINDOWS_CLI_LAUNCHER_FILENAME
} from '../../shared/kingud-artifacts'
import { nodeFileContentsEqual } from '../../shared/node-file-content-equality'
import { buildUnixCliLauncher } from '../cli/cli-dev-launcher'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveKingudInstallRoot, resolveUserDataPath } from './kingud-app-paths'

// Read by native/windows-cli-launcher: its presence beside kingu.exe selects the server mode.
export const KINGUD_WINDOWS_CLI_LAUNCHER_CONFIG_FILENAME = 'kingu-launcher.cfg'
const RETIRED_LAUNCHER_SUFFIX = '.retired'

let launcherPath: string | null = null

export function getKingudCliLauncherPath(): string | null {
  return launcherPath
}

export async function prepareKingudCliLauncher(): Promise<void> {
  launcherPath = null
  const installRoot = resolveKingudInstallRoot()
  const entry = join(installRoot, ...KINGUD_CLI_ENTRY_FILENAME.split('/'))
  // Older server slots and source-only runs may not include the CLI yet.
  if (!existsSync(entry)) {
    return
  }
  const userDataPath = resolveUserDataPath()
  const binDir = join(userDataPath, 'cli', 'bin')
  if (process.platform === 'win32') {
    launcherPath = await prepareWindowsLauncher(installRoot, entry, userDataPath, binDir)
    return
  }
  const path = join(binDir, 'kingu')
  const script = buildUnixCliLauncher(process.execPath, entry, userDataPath, 'node')
  await mkdir(binDir, { recursive: true })
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== script) {
    writeFileAtomically(path, script, { mode: 0o700 })
  }
  await chmod(path, 0o700)
  launcherPath = path
}

export function buildWindowsCliLauncherConfig(
  nodePath: string,
  cliEntryPath: string,
  userDataPath: string
): string {
  return `node=${nodePath}\ncli=${cliEntryPath}\nuser-data=${userDataPath}\n`
}

/** A native exe, never a .cmd: cmd.exe reparses `%*` and cannot carry a multi-line body. */
async function prepareWindowsLauncher(
  installRoot: string,
  entry: string,
  userDataPath: string,
  binDir: string
): Promise<string | null> {
  const source = join(installRoot, ...KINGUD_WINDOWS_CLI_LAUNCHER_FILENAME.split('/'))
  if (!existsSync(source)) {
    return null
  }
  const path = join(binDir, 'kingu.exe')
  await mkdir(binDir, { recursive: true })
  await removeRetiredLaunchers(binDir)
  const binary = await readFile(source)
  if (!(await nodeFileContentsEqual(path, binary).catch(() => false))) {
    try {
      writeFileAtomically(path, binary)
    } catch {
      // A running `kingu` keeps its image mapped; Windows still lets it be renamed away.
      await rename(path, `${path}.${randomUUID()}${RETIRED_LAUNCHER_SUFFIX}`)
      writeFileAtomically(path, binary)
    }
  }
  const configPath = join(binDir, KINGUD_WINDOWS_CLI_LAUNCHER_CONFIG_FILENAME)
  const config = buildWindowsCliLauncherConfig(process.execPath, entry, userDataPath)
  if ((await readFile(configPath, 'utf8').catch(() => null)) !== config) {
    writeFileAtomically(configPath, config)
  }
  return path
}

async function removeRetiredLaunchers(binDir: string): Promise<void> {
  const names = await readdir(binDir).catch(() => [])
  await Promise.all(
    names
      .filter((name) => name.startsWith('kingu.exe.') && name.endsWith(RETIRED_LAUNCHER_SUFFIX))
      // One still running stays until a later start.
      .map((name) => rm(join(binDir, name), { force: true }).catch(() => {}))
  )
}
