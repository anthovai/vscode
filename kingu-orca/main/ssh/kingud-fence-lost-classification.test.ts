import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { execKingudStateMutation } from './kingud-state-mutation-exec'
import { execKingudRemote, execKingudRemoteOr } from './kingud-remote-runtime-control'
import {
  KINGUD_FENCE_LOST_MARKER,
  KingudFenceLostError,
  isKingudFenceLost,
  posixKingudFenceGuard,
  runWithKingudFence
} from './kingud-activation-fence-scope'
import { isUnconfirmedSshCommandTermination, sshCommandExitError } from './ssh-relay-exec-command'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { KingudHostTransport } from './kingud-host-transport'

/** An ssh2 exec channel; the host never acknowledges a close, as when the link is down. */
class HostChannel extends EventEmitter {
  readonly stderr = Object.assign(new EventEmitter(), { resume: () => {} })
  readonly stdin = this
  close(): void {}
  resume(): void {}
  exit(code: number, stdout: string): void {
    this.emit('data', Buffer.from(stdout))
    this.emit('close', code)
  }
}

let channel: HostChannel
const commands: string[] = []
const conn = {
  exec: async (command: string) => {
    commands.push(command)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand reads only the channel events, close() and resume() HostChannel implements.
    return channel as unknown as ClientChannel
  },
  usesSystemSshTransport: () => false
}
const target = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only exec and usesSystemSshTransport are read.
  conn: conn as unknown as KingudHostTransport,
  host: getRemoteHostPlatform('linux-x64')
}
const fence = {
  lockDir: '/home/u/.kingu-remote/.kingud-activation-transaction/.install-lock',
  token: 't1'
}

// As serializedStateMutationCommand builds it: the guard leads the mutation.
const mutation = `${posixKingudFenceGuard(fence)} restore`

function fenced<T>(run: () => Promise<T>): Promise<T> {
  return runWithKingudFence(fence, run)
}

async function settledAfter(step: Promise<unknown>, answer: () => void): Promise<unknown> {
  const settled = step.catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  answer()
  return settled
}

beforeEach(() => {
  vi.useFakeTimers()
  channel = new HostChannel()
  commands.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

// Round 13: the real exec error quotes the command, and every fenced command carries the marker.
describe('a fenced step through the real exec', () => {
  it('stays an ordinary failure when the step itself exits nonzero', async () => {
    const error = await settledAfter(
      fenced(() => execKingudRemote(target, 'false')),
      () => channel.exit(1, 'boom\n')
    )
    expect(commands[0]).toContain(KINGUD_FENCE_LOST_MARKER)
    expect(error).not.toBeInstanceOf(KingudFenceLostError)
    expect(error).toMatchObject({ exitCode: 1, stdout: 'boom\n' })
  })

  it('lets a failed step fall back', async () => {
    const answer = await settledAfter(
      fenced(() => execKingudRemoteOr(target, 'false', 'FALLBACK')),
      () => channel.exit(1, '')
    )
    expect(answer).toBe('FALLBACK')
  })

  it('keeps a timed-out step unconfirmed, so the fence is not released under it', async () => {
    const settled = fenced(() => execKingudRemoteOr(target, 'sleep 99', 'FALLBACK')).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await settled
    expect(error).not.toBeInstanceOf(KingudFenceLostError)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(true)
  })

  it('reads the guard’s own exit as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execKingudRemote(target, 'true')),
      () => channel.exit(75, `${KINGUD_FENCE_LOST_MARKER}\n`)
    )
    expect(error).toBeInstanceOf(KingudFenceLostError)
  })

  it('does not read a marker-free exit 75 as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execKingudRemote(target, 'true')),
      () => channel.exit(75, 'other\n')
    )
    expect(error).not.toBeInstanceOf(KingudFenceLostError)
  })
})

describe('a fenced state mutation through the real exec', () => {
  it('stays an ordinary failure when the mutation exits nonzero', async () => {
    const error = await settledAfter(
      fenced(() => execKingudStateMutation(target, mutation)),
      () => channel.exit(2, 'no snapshot\n')
    )
    expect(error).not.toBeInstanceOf(KingudFenceLostError)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(false)
  })

  it('reads the guard’s own exit as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execKingudStateMutation(target, mutation)),
      () => channel.exit(75, `${KINGUD_FENCE_LOST_MARKER}\n`)
    )
    expect(error).toBeInstanceOf(KingudFenceLostError)
  })
})

describe('a Windows host op whose exit PowerShell flattened to 1', () => {
  it('is a lost fence only when the host script printed the marker', () => {
    const op = `powershell.exe -Command "& 'node.exe' 'host.js' --fence d t ${KINGUD_FENCE_LOST_MARKER}"`
    expect(isKingudFenceLost(sshCommandExitError(op, 1, `${KINGUD_FENCE_LOST_MARKER}\r\n`))).toBe(
      true
    )
    expect(isKingudFenceLost(sshCommandExitError(op, 1, 'ENOENT\r\n'))).toBe(false)
  })
})
