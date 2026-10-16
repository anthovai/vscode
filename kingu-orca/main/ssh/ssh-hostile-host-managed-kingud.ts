/**
 * One hostile-host cell: on a fresh host, resolve the context, deploy kingud, and prove it picked
 * the cell's runtime, uploaded no other and ran no toolchain. An activated server must be live; an
 * unavailable host must fail with the classified reason the connect reports.
 */
import { posix } from 'node:path'
import { expect } from 'vitest'
import { NODE_RUNTIME_ASSETS, pinnedNodeRuntimeAsset } from '../../shared/node-runtime-pin'
import { KINGUD_MANAGED_REMOTE_PORT } from '../../shared/kingud-managed-runtime'
import { KINGUD_RUNTIMES_DIRNAME } from '../../shared/kingud-artifacts'
import type { SshTarget } from '../../shared/ssh-types'
import { readKingudActivationRecord } from './kingud-activation-record-store'
import { classifyKingudHostUnavailable } from '../kingud/kingud-host-unavailable'
import { managedKingudSlot } from './kingud-managed-runtime-context'
import { kingudSlotDir, type KingudSlotOptions } from './kingud-recovery-slot'
import { resolveKingudRemoteContext } from './kingud-remote-context'
import { deployKingud } from './kingud-remote-deploy'
import { kingudLivenessProbeCommand, parseKingudLiveness } from './kingud-remote-launch'
import { execKingudRemote } from './kingud-remote-runtime-control'
import { decommissionRemoteKingud } from './kingud-remote-decommission'
import { shellEscape } from './ssh-connection-utils'
import {
  forbiddenToolActions,
  type HostileHostCellCore,
  type ManagedKingudExpectation
} from './ssh-hostile-host-cells'
import { connectHostileHost } from './ssh-hostile-host-test-harness'
import { hostExec, hostExecStatus, type HostileHostTarget } from './ssh-hostile-host-test-fixture'

const EMPTY_CENSUS = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }

export async function proveManagedKingudCell(
  cell: HostileHostCellCore,
  target: HostileHostTarget,
  sshTarget: SshTarget
): Promise<void> {
  const expected = cell.managed
  const conn = await connectHostileHost(sshTarget)
  try {
    const context = await resolveKingudRemoteContext(sshTarget, conn)
    expect(context.serverTarget).toBe(expected.runtime)
    const slot = managedKingudSlot(context, KINGUD_MANAGED_REMOTE_PORT)
    const deploy = deployKingud({ ...slot, target: context.serverTarget, census: EMPTY_CENSUS })
    if (expected.outcome === 'unavailable') {
      const failure = await deploy.then(
        (deployed) => new Error(`deploy did not fail: ${JSON.stringify(deployed)}`),
        (error: unknown) => error
      )
      expect(classifyKingudHostUnavailable(failure), String(failure)).toBe(expected.reason)
    } else {
      const deployed = await deploy
      const slotDir = kingudSlotDir(slot, deployed.fullVersion)
      await assertOnlyRuntimeUploaded(target, slotDir, expected)
      // The message carries the full reason, which toMatchObject's diff omits.
      expect(deployed, JSON.stringify(deployed)).toMatchObject({
        outcome: 'installed-and-activated'
      })
      await assertLiveThenDecommissioned(slot, slotDir, deployed.fullVersion)
    }
    const toolLog = await hostExec(
      target,
      `cat ${shellEscape(target.forbiddenToolLog)} 2>/dev/null || true`
    )
    expect(forbiddenToolActions(toolLog)).toEqual([])
  } finally {
    await conn.disconnect().catch(() => {})
  }
}

/** A default runtime beside the expected one is the wrong upload this cell guards against. */
async function assertOnlyRuntimeUploaded(
  target: HostileHostTarget,
  slotDir: string,
  expected: ManagedKingudExpectation
): Promise<void> {
  const runtimes = posix.join(posix.dirname(slotDir), KINGUD_RUNTIMES_DIRNAME)
  const runtimeDir = (sha: string): string => posix.join(runtimes, `node-${sha}`)
  const { executableSha256 } = pinnedNodeRuntimeAsset(expected.runtime)
  expect(await hostExecStatus(target, `test -x '${runtimeDir(executableSha256)}/bin/node'`)).toBe(0)
  for (const asset of Object.values(NODE_RUNTIME_ASSETS)) {
    if (asset.executableSha256 !== executableSha256) {
      expect(
        await hostExecStatus(target, `test -e '${runtimeDir(asset.executableSha256)}'`)
      ).not.toBe(0)
    }
  }
}

async function assertLiveThenDecommissioned(
  slot: KingudSlotOptions,
  slotDir: string,
  version: string
): Promise<void> {
  const liveness = async (): Promise<string> =>
    parseKingudLiveness(
      await execKingudRemote(slot, kingudLivenessProbeCommand(slot.host, slotDir))
    )
  expect(await liveness()).toBe('LIVE')
  const decommission = await decommissionRemoteKingud({
    ...slot,
    record: await readKingudActivationRecord(slot),
    census: EMPTY_CENSUS
  })
  expect(decommission, JSON.stringify(decommission)).toMatchObject({
    outcome: 'decommissioned',
    version
  })
  expect(await liveness()).toBe('DEAD')
}
