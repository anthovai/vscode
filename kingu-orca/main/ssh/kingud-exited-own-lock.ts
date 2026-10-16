/**
 * A lock this desktop's own earlier process took and exited without releasing (BUG-23): the
 * activation fence, or a version dir's install lock a quit left mid-upload. The steal takes it
 * without the 20-minute wait, but only through its own arbitration and only while the lock is the
 * same instance and still names the exited holder's token. Process exit alone is not enough: sshd
 * keeps pty-less steps running, so the lock must also be quiet for three heartbeats and, for the
 * fence, there must be no state-mutation lock at all; the steal then holds that lock across the
 * takeover, and a mutation rechecks its fence once it holds it, so the two never overlap.
 */
import {
  KINGUD_FENCE_OWNER_FILENAME,
  posixKingudFenceOwnedTest
} from './kingud-activation-fence-scope'
import {
  forgetHeldKingudFence,
  kingudFenceTokensHeldByExitedProcesses
} from './kingud-held-fence-tokens'
import { readBoundedKingudRemoteRecord } from './kingud-remote-record-file'
import { execKingudRemote, type KingudRemoteExecTarget } from './kingud-remote-runtime-control'
import {
  installKingudWindowsHostScript,
  kingudWindowsHostOpCommand
} from './kingud-remote-windows-node'
import {
  KINGUD_EXITED_OWN_LOCK_QUIET_SECONDS,
  KINGUD_STATE_MUTATION_LOCK_DIRNAME
} from './kingud-state-snapshot-members'
import { CMD_EXE_COMMAND_LINE_MAX_CHARS } from '../providers/windows-shell-args'
import { shellEscape } from './ssh-connection-utils'
import type { InstallLockExitedOwnerProof } from './ssh-relay-install-lock'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'

// Keeps the Windows command line short; an older token left out only waits out the stale window.
const MAX_WINDOWS_CANDIDATES = 16

/** `baseDir` is `~/.kingu-remote`; `guardsStateMutation` means a live state mutation there keeps the lock. */
export type ExitedOwnLockScope = { baseDir: string; guardsStateMutation: boolean }

export function exitedOwnLockProof(
  target: KingudRemoteExecTarget,
  scope: ExitedOwnLockScope
): InstallLockExitedOwnerProof {
  return {
    find: (lockDir) => findExitedOwnLockToken(target, lockDir, scope),
    reclaimed: forgetHeldKingudFence,
    quietSeconds: KINGUD_EXITED_OWN_LOCK_QUIET_SECONDS,
    mutationLock: mutationLockOf(target, scope) ?? undefined
  }
}

/** Read-only: the token of an exited holder of this desktop the lock still names, or null. */
export async function findExitedOwnLockToken(
  target: KingudRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope
): Promise<string | null> {
  const exited = kingudFenceTokensHeldByExitedProcesses()
  if (exited.length === 0) {
    return null
  }
  try {
    const token = isWindowsRemoteHost(target.host)
      ? await findOnWindows(target, lockDir, scope, exited.slice(-MAX_WINDOWS_CANDIDATES))
      : await findOnPosix(target, lockDir, scope, exited)
    return token !== null && exited.includes(token) ? token : null
  } catch {
    // Unanswered: the stale window still applies.
    return null
  }
}

function mutationLockOf(target: KingudRemoteExecTarget, scope: ExitedOwnLockScope): string | null {
  return scope.guardsStateMutation
    ? joinRemotePath(target.host, scope.baseDir, KINGUD_STATE_MUTATION_LOCK_DIRNAME)
    : null
}

async function findOnPosix(
  target: KingudRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope,
  exited: string[]
): Promise<string | null> {
  const owner = await readBoundedKingudRemoteRecord(
    target,
    joinRemotePath(target.host, lockDir, KINGUD_FENCE_OWNER_FILENAME),
    64
  )
  const token = owner.state === 'present' ? owner.raw.trim() : ''
  if (!exited.includes(token)) {
    return null
  }
  const command = exitedOwnLockCheckCommand({ lockDir, token }, mutationLockOf(target, scope))
  return (await execKingudRemote(target, command)).trim() === 'EXITED_OWNER' ? token : null
}

/** The host script reads the owner itself, so one node.exe answers with the token it found. */
async function findOnWindows(
  target: KingudRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope,
  exited: string[]
): Promise<string | null> {
  const command = kingudWindowsHostOpCommand(target.host, scope.baseDir, 'fence-exited-owner', [
    lockDir,
    scope.guardsStateMutation ? '1' : '0',
    ...exited
  ])
  // Too long for sshd's cmd.exe: no proof, so the stale window applies.
  if (command.length > CMD_EXE_COMMAND_LINE_MAX_CHARS) {
    return null
  }
  await installKingudWindowsHostScript(target, scope.baseDir)
  const output = await execKingudRemote(target, command)
  const match = /^EXITED_OWNER (\S+)$/u.exec(output.trim().split(/\r?\n/u).at(-1) ?? '')
  return match ? match[1] : null
}

function exitedOwnLockCheckCommand(
  lock: { lockDir: string; token: string },
  mutationLock: string | null
): string {
  const quiet = (path: string): string =>
    `[ -n "$(find ${path} -maxdepth 0 -mmin +${KINGUD_EXITED_OWN_LOCK_QUIET_SECONDS / 60} 2>/dev/null)" ]`
  return [
    `${posixKingudFenceOwnedTest(lock)} && ${quiet(shellEscape(lock.lockDir))} || exit 0;`,
    ...(mutationLock
      ? [
          // Any mutation lock refuses, as the steal does: it can only take an absent one.
          `[ -e ${shellEscape(mutationLock)} ] && exit 0;`
        ]
      : []),
    'echo EXITED_OWNER'
  ].join(' ')
}
