/**
 * Small JSON records Kingu keeps on an kingud host (activation, transactions, stop receipts).
 *
 * Reads are bounded and never swallow a failure: a record that could not be read is not an
 * absent one, and treating it as absent is how a client deploys over a live install.
 */
import { randomUUID } from 'node:crypto'
import { shellEscape } from './ssh-connection-utils'
import { removeRemoteFileCommand } from './ssh-remote-commands'
import { execKingudRemote, type KingudRemoteExecTarget } from './kingud-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { isWindowsRemoteHost } from './ssh-remote-platform'
import {
  kingudRemoteBaseDir,
  kingudWindowsHostOpCommand,
  readKingudWindowsEncodedAnswer
} from './kingud-remote-windows-node'
import {
  KINGUD_RECORD_ABSENT_MARKER as ABSENT_MARKER,
  KINGUD_RECORD_PRESENT_MARKER as PRESENT_MARKER
} from './kingud-windows-host-script'

/** `present` carries raw bytes; schema checks belong to the caller that owns the format. */
export type KingudRemoteRecordRead = { state: 'absent' } | { state: 'present'; raw: string }

/** `~/.kingu-remote`, where the host script and the pinned runtime live. */
function windowsBaseDir(target: KingudRemoteExecTarget): string {
  if (!target.remoteHome) {
    throw new Error(
      'kingud host records on Windows need the remote home to find the pinned node.exe'
    )
  }
  return kingudRemoteBaseDir(target.host, target.remoteHome)
}

export async function readBoundedKingudRemoteRecord(
  target: KingudRemoteExecTarget,
  path: string,
  maxBytes: number
): Promise<KingudRemoteRecordRead> {
  if (isWindowsRemoteHost(target.host)) {
    return readWindowsRecord(target, path, maxBytes)
  }
  const file = shellEscape(path)
  // Why markers: an empty stdout must never be mistaken for "no record" when the read failed.
  const output = await execKingudRemote(
    target,
    `if [ ! -e ${file} ] && [ ! -L ${file} ]; then printf '%s\\n' ${ABSENT_MARKER}; exit 0; fi; ` +
      `[ -f ${file} ] || exit 65; size=$(wc -c < ${file}) || exit 65; ` +
      `[ "$size" -le ${maxBytes} ] || exit 65; ` +
      `printf '%s\\n' ${PRESENT_MARKER}; cat ${file}`
  )
  const newline = output.indexOf('\n')
  const marker = (newline === -1 ? output : output.slice(0, newline)).trim()
  if (marker === ABSENT_MARKER) {
    return { state: 'absent' }
  }
  if (marker !== PRESENT_MARKER) {
    throw new Error('kingud host record read returned no verifiable answer')
  }
  return { state: 'present', raw: newline === -1 ? '' : output.slice(newline + 1) }
}

async function readWindowsRecord(
  target: KingudRemoteExecTarget,
  path: string,
  maxBytes: number
): Promise<KingudRemoteRecordRead> {
  const output = await execKingudRemote(
    target,
    kingudWindowsHostOpCommand(target.host, windowsBaseDir(target), 'record-read', [
      path,
      String(maxBytes)
    ])
  )
  if (output.split(/\r?\n/u).some((line) => line.trim() === ABSENT_MARKER)) {
    return { state: 'absent' }
  }
  const raw = readKingudWindowsEncodedAnswer(output, PRESENT_MARKER)
  if (raw === null) {
    throw new Error('kingud host record read returned no verifiable answer')
  }
  return { state: 'present', raw }
}

export async function writeAtomicKingudRemoteRecord(
  target: KingudRemoteExecTarget,
  path: string,
  contents: string
): Promise<void> {
  const partialPath = `${path}.partial.${process.pid}.${randomUUID()}`
  const baseDir = isWindowsRemoteHost(target.host) ? windowsBaseDir(target) : null
  try {
    if (baseDir) {
      await target.conn.writeFile(partialPath, contents, {
        hostPlatform: target.host,
        signal: target.signal
      })
      await execKingudRemote(
        target,
        kingudWindowsHostOpCommand(target.host, baseDir, 'record-publish', [partialPath, path])
      )
      return
    }
    await execKingudRemote(
      target,
      `umask 077; printf %s ${shellEscape(contents)} > ${shellEscape(partialPath)} && ` +
        `mv -f ${shellEscape(partialPath)} ${shellEscape(path)}`
    )
  } catch (error) {
    // Why keep the partial on an unconfirmed termination: the write may still be running there.
    if (!isUnconfirmedSshCommandTermination(error)) {
      const discard = baseDir
        ? kingudWindowsHostOpCommand(target.host, baseDir, 'remove-file', [partialPath])
        : removeRemoteFileCommand(target.host, partialPath)
      await execKingudRemote(target, discard).catch(() => {})
    }
    throw error
  }
}
