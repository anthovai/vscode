/**
 * The record that tells a clean idle stop apart from a crash. Written just before an idle
 * stop and discarded if that stop fails; the next start reports it once and removes it, so a
 * later crash never inherits it.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  KINGUD_IDLE_STOP_RECORD_FILENAME,
  KingudIdleStopRecordSchema,
  type KingudIdleStopRecord
} from '../../shared/kingud-idle-exit'
import type { KingudIdleExitEvidence } from './kingud-idle-exit-monitor'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

const RECORD_MAX_BYTES = 16 * 1024

export function kingudIdleStopRecordPath(userDataPath: string): string {
  return join(userDataPath, KINGUD_IDLE_STOP_RECORD_FILENAME)
}

export function writeKingudIdleStopRecord(
  userDataPath: string,
  evidence: KingudIdleExitEvidence,
  version: string
): void {
  const record: KingudIdleStopRecord = {
    schemaVersion: 1,
    kind: 'kingud_idle_stop',
    pid: process.pid,
    version,
    quietSince: new Date(evidence.quietSince).toISOString(),
    stoppedAt: new Date(evidence.stoppedAt).toISOString(),
    idleTimeoutMs: evidence.timeoutMs
  }
  if (!writeDurableSecureJsonFile(kingudIdleStopRecordPath(userDataPath), record)) {
    throw new Error('kingud_idle_stop_record_permissions_unconfirmed')
  }
}

/** The previous run's idle stop, or null when it ended any other way (or never ran). */
export function consumeKingudIdleStopRecord(userDataPath: string): KingudIdleStopRecord | null {
  const path = kingudIdleStopRecordPath(userDataPath)
  let record: KingudIdleStopRecord | null = null
  try {
    const raw = readNodeFileSyncWithinLimit(path, RECORD_MAX_BYTES).buffer.toString('utf8')
    record = KingudIdleStopRecordSchema.parse(JSON.parse(raw))
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    console.error('[kingud] ignoring an unreadable idle-stop record:', error)
  }
  rmSync(path, { force: true })
  return record
}

export function discardKingudIdleStopRecord(userDataPath: string): void {
  rmSync(kingudIdleStopRecordPath(userDataPath), { force: true })
}
