import { describe, expect, it, vi } from 'vitest'
import {
  findOrphanedKinguSshForward,
  stopOrphanedKinguSshForward,
  type SshForwardProcessRow
} from './system-ssh-orphaned-forward'

const EXPECTED = [
  '-o',
  'BatchMode=no',
  '-T',
  '-N',
  '-o',
  'ExitOnForwardFailure=no',
  '-L',
  '127.0.0.1:47123:127.0.0.1:6768',
  '--',
  'devbox'
]
// What an earlier version spawned for the same forward: ExitOnForwardFailure=yes.
const KINGU_FORWARD =
  '/usr/bin/ssh -o BatchMode=no -T -N -o ExitOnForwardFailure=yes -L 127.0.0.1:47123:127.0.0.1:6768 -- devbox'

function row(pid: number, ppid: number, command: string, creationTimeMs?: number) {
  return { pid, ppid, command, creationTimeMs } satisfies SshForwardProcessRow
}

describe('findOrphanedKinguSshForward', () => {
  it('finds a reparented Kingu forward for this exact forward (macOS/Linux init)', () => {
    expect(findOrphanedKinguSshForward([row(900, 1, KINGU_FORWARD)], EXPECTED, 'darwin')?.pid).toBe(
      900
    )
  })

  it('finds one reparented to a systemd --user subreaper', () => {
    const rows = [row(50, 1, '/usr/lib/systemd/systemd --user'), row(900, 50, KINGU_FORWARD)]
    expect(findOrphanedKinguSshForward(rows, EXPECTED, 'linux')?.pid).toBe(900)
  })

  it('matches across the LogLevel=INFO this version adds, in either direction', () => {
    const withLogLevel = ['-o', 'BatchMode=no', '-o', 'LogLevel=INFO', ...EXPECTED.slice(2)]
    expect(
      findOrphanedKinguSshForward([row(900, 1, KINGU_FORWARD)], withLogLevel, 'darwin')?.pid
    ).toBe(900)
    const newOrphan = `/usr/bin/ssh ${withLogLevel.join(' ')}`
    expect(findOrphanedKinguSshForward([row(900, 1, newOrphan)], withLogLevel, 'darwin')?.pid).toBe(
      900
    )
  })

  it("never picks a forward whose Kingu is still running (another instance's tunnel)", () => {
    const rows = [
      row(400, 1, '/Applications/Kingu.app/Contents/MacOS/Kingu'),
      row(900, 400, KINGU_FORWARD)
    ]
    expect(findOrphanedKinguSshForward(rows, EXPECTED, 'darwin')).toBeNull()
  })

  it("never picks the user's own ssh on the port, even an orphaned daemon in Kingu's flag order", () => {
    const rows = [
      row(900, 1, 'ssh -N -L 127.0.0.1:47123:127.0.0.1:6768 devbox'),
      row(
        901,
        1,
        'ssh -o BatchMode=yes -T -N -o ExitOnForwardFailure=yes -L 127.0.0.1:47123:127.0.0.1:5432 -- production-db'
      ),
      row(902, 1, KINGU_FORWARD.replace('-- devbox', '-- otherbox')),
      row(903, 1, KINGU_FORWARD.replace('/usr/bin/ssh ', '/usr/bin/ssh -f -F /home/u/.ssh/prod '))
    ]
    expect(findOrphanedKinguSshForward(rows, EXPECTED, 'darwin')).toBeNull()
  })

  it('never picks a forward for another port that shares a prefix', () => {
    const command = KINGU_FORWARD.replace('127.0.0.1:47123:', '127.0.0.1:471230:')
    expect(findOrphanedKinguSshForward([row(900, 1, command)], EXPECTED, 'darwin')).toBeNull()
  })

  it('on Windows, treats a missing or younger parent as gone', () => {
    const command = `"C:\\Windows\\System32\\OpenSSH\\ssh.exe" ${KINGU_FORWARD.slice('/usr/bin/ssh '.length)}`
    expect(
      findOrphanedKinguSshForward([row(900, 400, command, 1_000)], EXPECTED, 'win32')?.pid
    ).toBe(900)
    expect(
      findOrphanedKinguSshForward(
        [row(400, 4, 'C:\\Program Files\\Other\\other.exe', 2_000), row(900, 400, command, 1_000)],
        EXPECTED,
        'win32'
      )?.pid
    ).toBe(900)
    expect(
      findOrphanedKinguSshForward(
        [row(400, 4, 'C:\\Kingu\\Kingu.exe', 500), row(900, 400, command, 1_000)],
        EXPECTED,
        'win32'
      )
    ).toBeNull()
  })
})

function esrch(): Error {
  return Object.assign(new Error('gone'), { code: 'ESRCH' })
}

describe('stopOrphanedKinguSshForward', () => {
  it('terminates the orphan and waits until it is gone', async () => {
    let alive = true
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0 && !alive) {
        throw esrch()
      }
      if (signal === 'SIGTERM') {
        alive = false
      }
    })
    const stopped = await stopOrphanedKinguSshForward(47123, EXPECTED, {
      listProcesses: async () => [row(900, 1, KINGU_FORWARD)],
      kill,
      readStartTimeMs: async () => 1_000,
      platform: 'darwin'
    })
    expect(stopped).toBe(true)
    expect(kill).toHaveBeenCalledWith(900, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(900, 'SIGKILL')
  })

  it('escalates to SIGKILL only while the same orphan is still there', async () => {
    vi.useFakeTimers()
    try {
      const kill = vi.fn()
      const stopping = stopOrphanedKinguSshForward(47123, EXPECTED, {
        listProcesses: async () => [row(900, 1, KINGU_FORWARD)],
        kill,
        readStartTimeMs: async () => 1_000,
        platform: 'darwin'
      })
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(stopping).resolves.toBe(true)
      expect(kill).toHaveBeenCalledWith(900, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never SIGKILLs a pid that was reused after SIGTERM', async () => {
    vi.useFakeTimers()
    try {
      const kill = vi.fn()
      const listProcesses = vi
        .fn()
        .mockResolvedValueOnce([row(900, 1, KINGU_FORWARD)])
        .mockResolvedValue([row(900, 77, '/usr/bin/vim notes.txt'), row(77, 1, '/bin/zsh')])
      const readStartTimeMs = vi.fn().mockResolvedValueOnce(1_000).mockResolvedValue(90_000)
      const stopping = stopOrphanedKinguSshForward(47123, EXPECTED, {
        listProcesses,
        kill,
        readStartTimeMs,
        platform: 'darwin'
      })
      await vi.advanceTimersByTimeAsync(3_000)
      await stopping
      expect(kill).toHaveBeenCalledWith(900, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(900, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never SIGKILLs when the start time cannot be read, even for the same command', async () => {
    vi.useFakeTimers()
    try {
      const kill = vi.fn()
      const stopping = stopOrphanedKinguSshForward(47123, EXPECTED, {
        listProcesses: async () => [row(900, 1, KINGU_FORWARD)],
        kill,
        readStartTimeMs: async () => null,
        platform: 'darwin'
      })
      await vi.advanceTimersByTimeAsync(3_000)
      await stopping
      expect(kill).not.toHaveBeenCalledWith(900, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('touches nothing when no orphan holds the port, or the table cannot be read', async () => {
    const kill = vi.fn()
    await expect(
      stopOrphanedKinguSshForward(47123, EXPECTED, {
        listProcesses: async () => [],
        kill,
        readStartTimeMs: async () => 1_000,
        platform: 'darwin'
      })
    ).resolves.toBe(false)
    await expect(
      stopOrphanedKinguSshForward(47123, EXPECTED, {
        listProcesses: async () => {
          throw new Error('ps failed')
        },
        kill,
        readStartTimeMs: async () => 1_000,
        platform: 'darwin'
      })
    ).resolves.toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})
