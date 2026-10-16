/**
 * Decides when a managed kingud has been unused long enough to stop.
 *
 * Every probe must answer `idle` on the same check, continuously for the whole quiet period.
 * A probe that throws or cannot answer counts as busy: silence is never evidence of idleness.
 */

export type KingudIdleVerdict = 'idle' | 'busy' | 'unverifiable'

export type KingudIdleProbe = {
  name: string
  read: () => KingudIdleVerdict | Promise<KingudIdleVerdict>
}

export type KingudIdleExitEvidence = { quietSince: number; stoppedAt: number; timeoutMs: number }

export type KingudIdleExitMonitorOptions = {
  timeoutMs: number
  probes: readonly KingudIdleProbe[]
  /** Any client request restarts the quiet period, even one that came and went between checks. */
  lastClientActivityAt: () => number
  onIdle: (evidence: KingudIdleExitEvidence) => void | boolean | Promise<void | boolean>
  now?: () => number
  pollMs?: number
  log?: (line: string) => void
}

export function resolveKingudIdlePollMs(timeoutMs: number): number {
  return Math.min(60_000, Math.max(250, Math.floor(timeoutMs / 5)))
}

export class KingudIdleExitMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private quietSince: number | null = null
  private blocker: string | null = null
  private stopped = false
  private readonly now: () => number
  private readonly pollMs: number
  private readonly log: (line: string) => void

  constructor(private readonly options: KingudIdleExitMonitorOptions) {
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? resolveKingudIdlePollMs(options.timeoutMs)
    this.log = options.log ?? ((line) => console.error(line))
  }

  start(): void {
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** One check; resolves true once the quiet period elapsed and `onIdle` fired. */
  async check(): Promise<boolean> {
    const blocker = await this.findBlocker()
    if (this.stopped) {
      return false
    }
    const now = this.now()
    if (blocker) {
      if (this.quietSince !== null || this.blocker !== blocker) {
        this.log(`[kingud] idle exit waiting: ${blocker}`)
      }
      this.quietSince = null
      this.blocker = blocker
      return false
    }
    if (this.quietSince === null) {
      this.quietSince = now
      this.blocker = null
      this.log(`[kingud] idle; stopping after ${this.options.timeoutMs}ms unless a client returns`)
    }
    const quietSince = Math.max(this.quietSince, this.options.lastClientActivityAt())
    if (now - quietSince < this.options.timeoutMs) {
      return false
    }
    if (
      (await this.options.onIdle({
        quietSince,
        stoppedAt: now,
        timeoutMs: this.options.timeoutMs
      })) === false
    ) {
      this.quietSince = null
      return false
    }
    this.stop()
    return true
  }

  private async findBlocker(): Promise<string | null> {
    for (const probe of this.options.probes) {
      let verdict: KingudIdleVerdict
      try {
        verdict = await probe.read()
      } catch {
        verdict = 'unverifiable'
      }
      if (verdict !== 'idle') {
        return `${probe.name} ${verdict}`
      }
    }
    return null
  }

  private schedule(): void {
    if (this.stopped) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check()
        .catch((error: unknown) => this.log(`[kingud] idle check failed: ${String(error)}`))
        .finally(() => this.schedule())
    }, this.pollMs)
    // Never the reason the process stays alive.
    this.timer.unref?.()
  }
}
