/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** How much work went through one thing, over all time. */
export interface IKinguStatsTotals {
	/** Runs that started. A run is one stretch of an agent actually working. */
	runs: number;
	/** How long those runs took, in milliseconds. */
	workingMs: number;
}

/**
 * What this machine has done, kept between launches.
 *
 * Counters, not an event log. The ADE keeps every event and derives the
 * aggregates from them, which buys questions nobody has asked yet — "how much
 * last Tuesday" — at the price of a bounded file that silently loses its own
 * beginning once the bound is hit, and a schema to migrate. Two numbers and a
 * date answer what the feature is for, and they cannot be trimmed into being
 * wrong.
 */
export interface IKinguStatsState {
	readonly version: 1;
	/**
	 * When counting began.
	 *
	 * Written once and never moved, because "3 hours of agent time" means
	 * nothing without it.
	 */
	firstRunAt: number | undefined;
	totals: IKinguStatsTotals;
	/** By session type, which is the nearest thing to "which agent". */
	byType: Record<string, IKinguStatsTotals>;
}

export function emptyStats(): IKinguStatsState {
	return { version: 1, firstRunAt: undefined, totals: { runs: 0, workingMs: 0 }, byType: {} };
}

/**
 * Reads persisted state, or starts again.
 *
 * A shape that does not parse is discarded rather than repaired. These are
 * counters about the user's own habits: losing them costs a number, and
 * half-restoring them costs a number that is wrong without saying so.
 */
export function readStats(raw: string | undefined): IKinguStatsState {
	if (!raw) {
		return emptyStats();
	}
	try {
		const parsed = JSON.parse(raw) as Partial<IKinguStatsState>;
		if (parsed?.version !== 1) {
			return emptyStats();
		}
		const state = emptyStats();
		state.firstRunAt = positive(parsed.firstRunAt);
		state.totals = readTotals(parsed.totals);
		for (const [type, totals] of Object.entries(parsed.byType ?? {})) {
			state.byType[type] = readTotals(totals);
		}
		return state;
	} catch {
		return emptyStats();
	}
}

function readTotals(totals: Partial<IKinguStatsTotals> | undefined): IKinguStatsTotals {
	return { runs: positive(totals?.runs) ?? 0, workingMs: positive(totals?.workingMs) ?? 0 };
}

function positive(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Adds one finished run to the state, in both places it is counted. */
export function recordRun(state: IKinguStatsState, type: string, startedAt: number, durationMs: number): void {
	state.firstRunAt ??= startedAt;
	state.totals.runs++;
	state.totals.workingMs += durationMs;
	const byType = state.byType[type] ??= { runs: 0, workingMs: 0 };
	byType.runs++;
	byType.workingMs += durationMs;
}

/** What a session is doing, as far as counting working time is concerned. */
export const enum KinguRunState {
	/** The agent is working: this is what gets timed. */
	Working = 'working',
	/** Anything else — waiting, finished, failed, not yet sent. */
	Idle = 'idle',
}

/** What observing a session's state turned out to mean. */
export type KinguRunTransition =
	| { readonly kind: 'none' }
	| { readonly kind: 'started' }
	| { readonly kind: 'stopped'; readonly startedAt: number; readonly durationMs: number };

const NOTHING: KinguRunTransition = { kind: 'none' };

/**
 * How many sessions are tracked at once.
 *
 * A window that has been open for days accumulates sessions, and each one costs
 * an entry here whether or not it ever ran. Evicting the coldest costs at most
 * one unfinished run, which is the same thing a crash costs.
 */
const MAX_TRACKED = 1000;

/**
 * Turns a stream of session states into runs.
 *
 * The whole idempotency contract is here, and it is the reason this is a class
 * with no dependencies rather than logic inside the service: a state observable
 * re-fires for reasons that are not transitions — a re-render, a reconnect
 * replaying the last state, a title changing — and counting those would inflate
 * every number the feature reports.
 *
 * A run is opened when a session starts working and closed when it stops. Being
 * told the same state twice is not a transition. A close with nothing open is
 * dropped rather than counted from an unknown start.
 */
export class KinguRunTracker {

	/** Sessions currently working, and when each started. */
	private readonly _open = new Map<string, { startedAt: number; type: string }>();
	/** The last state seen per session, so a repeat can be told from a change. */
	private readonly _seen = new Map<string, KinguRunState>();

	constructor(private readonly _maxTracked = MAX_TRACKED) { }

	observe(sessionId: string, type: string, state: KinguRunState, now: number): KinguRunTransition {
		if (this._seen.get(sessionId) === state) {
			return NOTHING;
		}
		this._seen.set(sessionId, state);
		this._evictIfNeeded();

		if (state === KinguRunState.Working) {
			this._open.set(sessionId, { startedAt: now, type });
			return { kind: 'started' };
		}
		return this._close(sessionId, now);
	}

	/** Closes a session that has gone away, so its run is counted rather than lost. */
	forget(sessionId: string, now: number): KinguRunTransition {
		this._seen.delete(sessionId);
		return this._close(sessionId, now);
	}

	/** Closes everything still open, for a window that is shutting down. */
	closeAll(now: number): { sessionId: string; type: string; startedAt: number; durationMs: number }[] {
		const closed = [...this._open].map(([sessionId, run]) => ({
			sessionId,
			type: run.type,
			startedAt: run.startedAt,
			durationMs: Math.max(0, now - run.startedAt),
		}));
		this._open.clear();
		return closed;
	}

	/** The type a session is open under, for a caller applying a transition. */
	typeOf(sessionId: string): string | undefined {
		return this._open.get(sessionId)?.type;
	}

	get openCount(): number {
		return this._open.size;
	}

	private _close(sessionId: string, now: number): KinguRunTransition {
		const run = this._open.get(sessionId);
		if (!run) {
			// Nothing was open. A session that was already finished when this window
			// first saw it is not a run that happened here.
			return NOTHING;
		}
		this._open.delete(sessionId);
		return { kind: 'stopped', startedAt: run.startedAt, durationMs: Math.max(0, now - run.startedAt) };
	}

	private _evictIfNeeded(): void {
		while (this._seen.size > this._maxTracked) {
			const oldest = this._seen.keys().next();
			if (oldest.done) {
				return;
			}
			this._seen.delete(oldest.value);
			this._open.delete(oldest.value);
		}
	}
}

/** A duration as the unit a person would say: `3h 20m`, `45m`, `12s`. */
export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
