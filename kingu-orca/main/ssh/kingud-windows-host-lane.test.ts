// Managed kingud on a real Win32-OpenSSH host, one cell per DefaultShell: resolve the context
// (pinned node.exe, host script), deploy and activate, prove readiness and liveness, reach kingud
// through the stdio bridge (this account's sshd refuses forwarding), decommission through the
// instance-bound stop request, prove exit, and run a GC pass.
// config/ci/windows-ssh-provider/invoke-windows-host-cells.ps1 provisions the account and runs this
// file for `kingud-*` cells; ssh-windows-hosts.yml runs that.
//
// Run: KINGU_RUN_SSH_WINDOWS_HOST=1 KINGU_SSH_WINDOWS_HOST_CELL=<descriptor.json> pnpm test <this file>
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { SshConnection } from './ssh-connection'
import {
  connectHostileHost,
  installHostileHostAppEnvironment
} from './ssh-hostile-host-test-harness'
import { resolveKingudRemoteContext } from './kingud-remote-context'
import { proveWindowsStdioBridge } from './kingud-windows-stdio-bridge-test-cell'
import { deployKingud } from './kingud-remote-deploy'
import { kingudLivenessProbeCommand, parseKingudLiveness } from './kingud-remote-launch'
import { kingudSlotDir, type KingudSlotOptions } from './kingud-recovery-slot'
import { decommissionRemoteKingud } from './kingud-remote-decommission'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import { gcOldKingudVersions } from './kingud-remote-gc'
import { execKingudRemote } from './kingud-remote-runtime-control'
import { kingudWindowsNodeCommandLine } from './kingud-remote-windows-node'
import { joinRemotePath } from './ssh-remote-platform'
import {
  isWindowsKingudCellId,
  readWindowsHostCellDescriptor,
  windowsHostSshTarget
} from './ssh-windows-host-cells'

const RUN = process.env.KINGU_RUN_SSH_WINDOWS_HOST === '1'
const CELL_TIMEOUT_MS = 20 * 60_000

/** Kingud's own host ops and launches: these must never take a PowerShell hop. */
function isKingudHostCommand(command: string): boolean {
  return /kingud-host-script-[0-9a-f]{16}\.js|[\\/]kingud\.js /u.test(command)
}

describe.runIf(RUN)('managed kingud on a Windows OpenSSH host', () => {
  let cleanupAppEnvironment: (() => void) | null = null

  beforeAll(() => {
    cleanupAppEnvironment = installHostileHostAppEnvironment()
  })

  afterAll(() => {
    cleanupAppEnvironment?.()
  })

  it(
    'deploys, serves, decommissions by request and exits',
    async () => {
      const descriptor = readWindowsHostCellDescriptor(
        process.env.KINGU_SSH_WINDOWS_HOST_CELL ?? ''
      )
      if (!isWindowsKingudCellId(descriptor.cell)) {
        throw new Error(`${descriptor.cell} is not a managed kingud cell`)
      }
      const sshTarget = windowsHostSshTarget(descriptor, randomUUID())
      let exec: MockInstance<SshConnection['exec']> | null = null
      const receipt: Record<string, unknown> = { cell: descriptor.cell, target: descriptor.target }
      let conn: SshConnection | null = null
      try {
        conn = await connectHostileHost(sshTarget)
        exec = vi.spyOn(SshConnection.prototype, 'exec')
        const context = await resolveKingudRemoteContext(sshTarget, conn)
        expect(context.host.os).toBe('win32')
        const options: KingudSlotOptions = {
          conn,
          host: context.host,
          remoteHome: context.remoteHome,
          nodePath: 'node',
          userDataDir: context.userDataDir,
          bindHost: '127.0.0.1',
          port: 0
        }
        const deployed = await deployKingud({
          ...options,
          target: context.serverTarget,
          census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        })
        receipt.deploy = deployed
        expect(deployed.outcome).toBe('installed-and-activated')
        const slotDir = kingudSlotDir(options, deployed.fullVersion)
        const liveness = async () =>
          parseKingudLiveness(
            await execKingudRemote(options, kingudLivenessProbeCommand(options.host, slotDir))
          )
        expect(await liveness()).toBe('LIVE')
        // Managed terminals' `kingu`: the native launcher kingud installed in its profile.
        const cli = joinRemotePath(options.host, context.userDataDir, 'cli', 'bin', 'kingu.exe')
        const status = JSON.parse(
          await execKingudRemote(options, kingudWindowsNodeCommandLine(cli, ['status', '--json']))
        )
        receipt.cliStatus = status.result
        expect(status.result.runtime).toMatchObject({ reachable: true })
        expect(status.result.app.desktopWindowStatus).toBe('blocked')
        // The managed tunnel picks the stdio bridge on this account and reaches kingud through it.
        receipt.stdioBridge = await proveWindowsStdioBridge(conn, options.host, slotDir)
        expect(receipt.stdioBridge).toMatchObject({
          forwarding: 'refused',
          response: expect.stringMatching(/^HTTP\/1\.1 101/u)
        })
        // Decommission stops it by the instance-bound request kingud itself completes and proves.
        const record = await readKingudActivationRecord(options)
        receipt.decommission = await decommissionRemoteKingud({
          ...options,
          record,
          census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        })
        // The message carries the refusal code and reason, which toMatchObject's diff omits.
        expect(receipt.decommission, JSON.stringify(receipt.decommission)).toMatchObject({
          outcome: 'decommissioned',
          version: deployed.fullVersion
        })
        expect(await liveness()).toBe('DEAD')
        // A GC pass after decommission must leave the recorded previous slot in place.
        await gcOldKingudVersions({
          conn,
          host: options.host,
          remoteHome: options.remoteHome,
          currentDirAbsPath: slotDir,
          record: await readKingudActivationRecord(options)
        })
        expect(await liveness()).toBe('DEAD')

        const commands = exec.mock.calls.map(([command]) => String(command))
        const kingudCommands = commands.filter(isKingudHostCommand)
        receipt.kingudCommands = kingudCommands.length
        receipt.powershellCommands = commands.filter((command) =>
          /^powershell\.exe /iu.test(command)
        ).length
        expect(kingudCommands.length).toBeGreaterThan(0)
        for (const command of kingudCommands) {
          expect(command).not.toMatch(/EncodedCommand/u)
        }
        receipt.passed = true
      } finally {
        exec?.mockRestore()
        await conn?.disconnect().catch(() => {})
        writeFileSync(descriptor.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
      }
    },
    CELL_TIMEOUT_MS
  )
})
