/** The supervisor's dependencies, per-distro state and evidence gathering. */
import type { KingudTerminalCensus } from '../../shared/kingud-terminal-census'
import type { SystemPowerLifecycleListener } from '../system-power-lifecycle'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import type { WslGuestIdentity } from './wsl-guest-process-identity'
import type { WslKingudConnection, WslKingudConnectionManager } from './wsl-kingud-connection'
import type { WslKingudConnectionStatus } from './wsl-kingud-connection-status'
import {
  nextWslLivenessProbe,
  type WslLivenessEvidence,
  type WslLivenessTrigger
} from './wsl-kingud-liveness-verdict'
import type { WslKingudReconnectBackoff } from './wsl-kingud-reconnect-backoff'
import type { WslKingudWatch } from './wsl-kingud-watch'

/** A ready connection with a held watch re-reads only the running list this often. */
export const WSL_KINGUD_HEARTBEAT_MS = 120_000

/** How long a failed exit waits before trusting a list that still shows its distro running. */
export const EXIT_SETTLE_MS = 500

export type WslKingudTimer = { cancel(): void }

export type WslKingudLivenessDependencies = {
  manager: Pick<WslKingudConnectionManager, 'ensure' | 'get' | 'publish' | 'close'>
  readRunning: () => Promise<WslRunningDistrosRead>
  readIdentity: (distro: string, kingudPid: number | null) => Promise<WslGuestIdentity | null>
  openWatch: (connection: WslKingudConnection) => Promise<WslKingudWatch>
  collectCensus: (connection: WslKingudConnection) => Promise<KingudTerminalCensus>
  /** A WSL project or terminal the user can see is open on this distro. */
  hasUserVisibleWork: (distro: string) => boolean
  deferUntilRunning: (distro: string, key: string, task: () => unknown) => void
  /** C3's `ensureHeld`; called only while the distro is confirmed running, so it never boots. */
  ensureHolder?: (distro: string) => Promise<unknown>
  subscribePower?: (listener: SystemPowerLifecycleListener) => () => void
  monotonicNow?: () => number
  schedule?: (delayMs: number, task: () => void) => WslKingudTimer
  random?: () => number
  heartbeatMs?: number
}

export type Trigger = WslLivenessTrigger | 'heartbeat'

export type Supervised = {
  distro: string
  key: string
  generation: number
  expected: WslLivenessEvidence['expected']
  watch: WslKingudWatch | null
  timer: WslKingudTimer | null
  /** Ends a recovery's backoff wait early once the distro stops being supervised. */
  wakeWait: (() => void) | null
  backoff: WslKingudReconnectBackoff
  verifyStreak: number
  busy: boolean
  pending: Trigger | null
  state: WslKingudConnectionStatus['state'] | null
  lastBeatMs: number
}

export function defaultSchedule(delayMs: number, task: () => void): WslKingudTimer {
  const timer = setTimeout(task, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function failedExit(trigger: Trigger): boolean {
  return trigger !== 'heartbeat' && trigger.source !== 'verify' && trigger.code !== 0
}

export function confirmsRunning(running: WslRunningDistrosRead, key: string): boolean {
  return (
    running.status === 'confirmed' &&
    running.distros.some((candidate) => wslDistroHolderKey(candidate) === key)
  )
}

/** Asks only what the classifier still needs, in order: identity, then kingud's port. */
export async function gatherWslLivenessEvidence(
  evidence: WslLivenessEvidence,
  probes: {
    readIdentity: () => Promise<WslGuestIdentity | null>
    probePort: () => Promise<WslKingudWatch['signal']>
  }
): Promise<WslLivenessEvidence> {
  for (let probe = nextWslLivenessProbe(evidence); probe; probe = nextWslLivenessProbe(evidence)) {
    if (probe === 'identity') {
      evidence.identity = await probes.readIdentity()
    } else {
      evidence.kingudPort = await probes.probePort()
    }
  }
  return evidence
}

export function newSupervised(
  distro: string,
  key: string,
  nowMs: number,
  backoff: WslKingudReconnectBackoff
): Supervised {
  return {
    distro: distro.trim(),
    key,
    generation: 0,
    expected: { distroInstance: null, kingud: null },
    watch: null,
    timer: null,
    wakeWait: null,
    backoff,
    verifyStreak: 0,
    busy: false,
    pending: null,
    state: null,
    lastBeatMs: nowMs
  }
}

/** `onChange(false)` on a real resume only: subscribing reports the current state at once. */
export function subscribeWake(
  subscribePower: WslKingudLivenessDependencies['subscribePower'],
  onChange: (suspended: boolean) => void
): () => void {
  let subscribed = false
  const unsubscribe = subscribePower?.({
    onSuspend: () => onChange(true),
    onResume: () => {
      if (subscribed) {
        onChange(false)
      }
    }
  })
  subscribed = true
  return unsubscribe ?? (() => {})
}

/** A backoff wait that `disarm` ends early through `wakeWait`. */
export function cancellableWait(
  entry: Supervised,
  schedule: (delayMs: number, task: () => void) => WslKingudTimer,
  delayMs: number
): Promise<void> {
  return new Promise<void>((resolve) => {
    entry.wakeWait = resolve
    entry.timer = schedule(delayMs, resolve)
  }).finally(() => {
    entry.timer = null
    entry.wakeWait = null
  })
}

export async function ensureHolderQuietly(
  ensureHolder: WslKingudLivenessDependencies['ensureHolder'],
  distro: string
): Promise<void> {
  try {
    await ensureHolder?.(distro)
  } catch (error) {
    console.warn(`[wsl] holder re-ensure for ${distro} failed:`, error)
  }
}

/** Cancels the entry's timer and wake wait and closes its watch. */
export function disarmSupervised(entry: Supervised): void {
  entry.timer?.cancel()
  entry.timer = null
  entry.wakeWait?.()
  entry.wakeWait = null
  entry.watch?.close()
  entry.watch = null
}

/** Holds a new watch unless a later connect superseded this one or already holds one. */
export async function attachSupervisedWatch(
  entry: Supervised,
  openWatch: () => Promise<WslKingudWatch>,
  onExit: (code: number | null) => void
): Promise<WslKingudWatch['signal']> {
  const generation = entry.generation
  const watch = await openWatch()
  if (watch.signal !== 'ready') {
    return watch.signal
  }
  if (entry.generation !== generation || entry.watch) {
    watch.close()
    return 'ready'
  }
  entry.watch = watch
  watch.onExit((code) => {
    if (entry.watch === watch) {
      entry.watch = null
      onExit(code)
    }
  })
  return 'ready'
}
