/**
 * Reading the activation record off a host.
 *
 * Split out from the deploy driver because the rollback path needs it too, and because an
 * unreadable record must fail loudly in both: treating "I cannot parse this" as "nothing is
 * activated" would deploy over a live install and lose its rollback target.
 */
import type { KingudHostTransport } from './kingud-host-transport'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  KINGUD_ACTIVATION_FILENAME,
  emptyKingudActivationRecord,
  parseKingudActivationRecord,
  serializeKingudActivationRecord,
  type KingudActivationReadResult,
  type KingudActivationRecord
} from './kingud-activation-record'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  readBoundedKingudRemoteRecord,
  writeAtomicKingudRemoteRecord
} from './kingud-remote-record-file'

const KINGUD_ACTIVATION_RECORD_MAX_BYTES = 64 * 1024

type ActivationRecordTarget = {
  conn: KingudHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  signal?: AbortSignal
}

export function kingudActivationPath(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, KINGUD_ACTIVATION_FILENAME)
}

/** A failed read rejects; it never reads as absent, because absence would admit a fresh deploy. */
async function readActivationRecordState(
  options: ActivationRecordTarget
): Promise<KingudActivationReadResult> {
  const read = await readBoundedKingudRemoteRecord(
    options,
    kingudActivationPath(options.host, options.remoteHome),
    KINGUD_ACTIVATION_RECORD_MAX_BYTES
  )
  return read.state === 'absent' ? read : parseKingudActivationRecord(read.raw)
}

export async function readKingudActivationRecord(
  options: ActivationRecordTarget
): Promise<KingudActivationRecord> {
  const parsed = await readActivationRecordState(options)
  if (parsed.state === 'ok') {
    return parsed.record
  }
  if (parsed.state === 'unreadable') {
    // Why throw: an unreadable record is not an empty one. Treating it as empty would
    // activate over a live install and orphan its rollback target.
    throw new Error(`Cannot read this host's kingud activation record: ${parsed.reason}`)
  }
  return emptyKingudActivationRecord()
}

/** Refuses to replace a record this client cannot read, e.g. one a newer client wrote. */
export async function writeKingudActivationRecord(
  options: ActivationRecordTarget,
  record: KingudActivationRecord
): Promise<void> {
  const existing = await readActivationRecordState(options)
  if (existing.state === 'unreadable') {
    throw new Error(
      `Refusing to overwrite this host's kingud activation record: ${existing.reason}`
    )
  }
  await writeAtomicKingudRemoteRecord(
    options,
    kingudActivationPath(options.host, options.remoteHome),
    serializeKingudActivationRecord(record)
  )
}
