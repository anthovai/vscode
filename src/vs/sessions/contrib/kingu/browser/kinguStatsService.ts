/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IKinguStatsState, KinguRunState, KinguRunTracker, readStats, recordRun } from '../common/kinguStats.js';

export const IKinguStatsService = createDecorator<IKinguStatsService>('kinguStatsService');

export interface IKinguStatsService {
	readonly _serviceBrand: undefined;

	/** What this machine has done, over all time. */
	readonly state: IKinguStatsState;

	/** How many agents are working right now. */
	readonly working: number;
}

/**
 * Where the counters are kept.
 *
 * `StorageScope.PROFILE` because these are one person's habits in one profile,
 * and `StorageTarget.MACHINE` because they are a fact about this computer and
 * syncing them would add somebody else's agent time to yours.
 */
const STORAGE_KEY = 'kingu.stats';

/** How long writes are collected before one is made. */
const SAVE_DELAY_MS = 5_000;

/**
 * Counts what the agents on this machine have actually done.
 *
 * The one thing the vault cannot answer: it reads transcripts other agents left
 * behind, so it knows what was said and never how long anything took or how
 * often a run happened. That is only observable while it happens, which is
 * here.
 *
 * Fed from each session's own `status` observable rather than from a change
 * event, because the observable is the fork's own statement of what a session
 * is doing and is the same value the list and the icons read — so a number here
 * cannot disagree with what the user is looking at. The ADE derives the same
 * boundaries from its agent-hook stream and had to build a mirror to tell a
 * replayed status from a real transition; {@link KinguRunTracker} is that
 * mirror, and it is the only part of this that needed writing.
 *
 * Persisted through `IStorageService`. The ADE keeps a JSON file, a schema
 * version, a loader and a debounced snapshot writer for this; the window
 * already has all of that.
 */
export class KinguStatsService extends Disposable implements IKinguStatsService {

	declare readonly _serviceBrand: undefined;

	private readonly _state: IKinguStatsState;
	private readonly _tracker = new KinguRunTracker();
	/** One status subscription per session, dropped with the session. */
	private readonly _watched = this._register(new DisposableMap<string>());
	private readonly _save = this._register(new RunOnceScheduler(() => this._persist(), SAVE_DELAY_MS));

	get state(): IKinguStatsState {
		return this._state;
	}

	get working(): number {
		return this._tracker.openCount;
	}

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ISessionsManagementService private readonly _sessionsService: ISessionsManagementService,
	) {
		super();
		this._state = readStats(this._storageService.get(STORAGE_KEY, StorageScope.PROFILE));

		this._register(this._sessionsService.onDidChangeSessions(event => {
			for (const session of event.added) {
				this._watch(session);
			}
			for (const session of event.removed) {
				// A session that has gone closes its run rather than losing it: the
				// work happened whether or not the row is still on screen.
				this._apply(session.sessionId, session.sessionType, this._tracker.forget(session.sessionId, Date.now()));
				this._watched.deleteAndDispose(session.sessionId);
			}
		}));

		// A window that is closing writes what is open, so a run in progress is
		// counted at its length so far rather than dropped entirely.
		this._register(this._storageService.onWillSaveState(() => this._flush()));
	}

	private _watch(session: ISession): void {
		if (this._watched.has(session.sessionId)) {
			return;
		}
		this._watched.set(session.sessionId, autorun(reader => {
			const status = session.status.read(reader);
			// Only `InProgress` is the agent working. `NeedsInput` is the session
			// being alive and waiting on a person, which is not agent time and
			// counting it would turn "3 hours of agent work" into "3 hours with a
			// tab open".
			const state = status === SessionStatus.InProgress ? KinguRunState.Working : KinguRunState.Idle;
			this._apply(session.sessionId, session.sessionType, this._tracker.observe(session.sessionId, session.sessionType, state, Date.now()));
		}));
	}

	private _apply(sessionId: string, type: string, transition: ReturnType<KinguRunTracker['observe']>): void {
		if (transition.kind !== 'stopped') {
			return;
		}
		recordRun(this._state, type, transition.startedAt, transition.durationMs);
		this._save.schedule();
	}

	private _flush(): void {
		for (const run of this._tracker.closeAll(Date.now())) {
			recordRun(this._state, run.type, run.startedAt, run.durationMs);
		}
		this._persist();
	}

	private _persist(): void {
		this._storageService.store(STORAGE_KEY, JSON.stringify(this._state), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}
