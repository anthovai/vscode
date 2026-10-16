/**
 * Which incarnation of a WSL distro, and of kingud inside it, is running. Identity is the guest
 * kernel's boot id plus `/proc/<pid>/stat` start times, which count clock ticks since the VM
 * booted: the guest's wall clock can jump after a host sleep (microsoft/WSL#4179, #10006), and
 * a wall-clock start time would then mistake a live process for a new one, or the reverse.
 */
import type { KingudHostTransport } from '../ssh/kingud-host-transport'
import { execCommand } from '../ssh/ssh-relay-exec-command'

export type WslGuestIdentity = {
  /** `<boot_id>:<pid 1 start ticks>`; a distro restart (or a VM restart) changes it. */
  distroInstance: string
  /** kingud's `<pid>:<start ticks>`; null when no pid was asked for or the process is gone. */
  kingud: string | null
}

const SECTION = '--kingu-identity--'
const IDENTITY_TIMEOUT_MS = 10_000

/** One exec, so a classification never mixes two distro incarnations. */
export function wslGuestIdentityCommand(kingudPid: number | null): string {
  const kingud =
    kingudPid !== null && Number.isSafeInteger(kingudPid) && kingudPid > 0
      ? `cat /proc/${kingudPid}/stat 2>/dev/null; `
      : ''
  return [
    `cat /proc/sys/kernel/random/boot_id; echo ${SECTION}; cat /proc/1/stat; echo ${SECTION}; `,
    `${kingud}echo ${SECTION}`
  ].join('')
}

/** Field 22 of `/proc/<pid>/stat`; the name in field 2 may hold spaces and parentheses. */
export function procStatStartTicks(stat: string): string | null {
  const nameEnd = stat.lastIndexOf(')')
  if (nameEnd === -1) {
    return null
  }
  const fields = stat
    .slice(nameEnd + 1)
    .trim()
    .split(/\s+/)
  // Fields after the name start at field 3 (state), so field 22 sits at index 19.
  const ticks = fields[19]
  return ticks && /^\d+$/.test(ticks) ? ticks : null
}

function procStatPid(stat: string): string | null {
  const pid = /^\s*(\d+)\s+\(/.exec(stat)?.[1]
  return pid ?? null
}

export function parseWslGuestIdentity(output: string): WslGuestIdentity | null {
  const sections = output.split(SECTION)
  if (sections.length < 4) {
    return null
  }
  const bootId = sections[0].trim().split(/\s+/).at(-1) ?? ''
  const initTicks = procStatStartTicks(sections[1])
  if (!/^[0-9a-f-]{36}$/i.test(bootId) || !initTicks) {
    return null
  }
  const kingudStat = sections[2].trim()
  const kingudPid = kingudStat ? procStatPid(kingudStat) : null
  const kingudTicks = kingudStat ? procStatStartTicks(kingudStat) : null
  return {
    distroInstance: `${bootId.toLowerCase()}:${initTicks}`,
    kingud: kingudPid && kingudTicks ? `${kingudPid}:${kingudTicks}` : null
  }
}

/** null when the guest could not answer: that is unverifiable, never evidence of an exit. */
export async function readWslGuestIdentity(
  conn: KingudHostTransport,
  kingudPid: number | null
): Promise<WslGuestIdentity | null> {
  try {
    return parseWslGuestIdentity(
      await execCommand(conn, wslGuestIdentityCommand(kingudPid), {
        timeoutMs: IDENTITY_TIMEOUT_MS
      })
    )
  } catch {
    return null
  }
}
