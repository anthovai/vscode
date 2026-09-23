/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../log/common/log.js';
import { loadOrcaStartup } from '../../kinguOrca/electron-main/kinguOrcaHost.js';
import { KINGU_BRIDGED_SETTINGS } from '../common/kinguSettings.js';

export { KINGU_SETTINGS_CHANNEL_NAME } from '../common/kinguSettings.js';

/**
 * This window's handle on the ADE's settings store.
 *
 * The store is a main-process object and the ADE's, which is the whole reason
 * this exists: the Agents Window's Settings editor should be able to change
 * what the ADE does, and the sandboxed renderer cannot reach the object that
 * decides it.
 *
 * Only the keys in {@link KINGU_BRIDGED_SETTINGS} pass through. Not caution for
 * its own sake — the store holds credentials, account records and per-machine
 * paths beside the preferences, and a channel that forwarded any key on request
 * would hand a renderer all of it.
 */
export class KinguSettingsChannel extends Disposable implements IServerChannel {

	private readonly _onDidChange = this._register(new Emitter<Record<string, unknown>>());

	/** Whether the ADE's change listener is attached; it can only be once there is a store. */
	private _listening = false;

	/** Opened only when the ADE itself is not running. See {@link _orcaStore}. */
	private _ownStore: IOrcaSettingsStore | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	listen<T>(_context: unknown, event: string): Event<T> {
		if (event === 'onDidChange') {
			this._ensureListening();
			return this._onDidChange.event as Event<T>;
		}
		throw new Error(`No such event: ${event}`);
	}

	async call<T>(_context: unknown, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'read': return this._read() as T;
			case 'write': return this._write(arg as Record<string, unknown>) as T;
		}
		throw new Error(`No such command: ${command}`);
	}

	/**
	 * The ADE's store, once it exists.
	 *
	 * Read on every call rather than held: the store is built during the ADE's
	 * ready-phase startup, so a reference taken when this channel was registered
	 * would be null for the life of the process.
	 */
	private _orcaStore(): IOrcaSettingsStore | undefined {
		const orca = loadOrcaStartup() as IOrcaSettingsModule | undefined;
		if (!orca) {
			return undefined;
		}
		// The running program's own store, when the ADE's full startup has brought
		// one up. Read every time rather than held: it is built during the ready
		// phase, so a reference taken at registration would be null for good.
		const running = (orca.mainProcessState as { store?: IOrcaSettingsStore | null } | undefined)?.store;
		if (running) {
			return running;
		}
		// Otherwise this window is the only thing asking, and a store of our own is
		// what makes the settings real rather than a form that saves nowhere. Safe
		// for exactly the reason it is needed: the program whose store this would
		// collide with is the one that is not running.
		if (!this._ownStore) {
			try {
				// The store reads `userData` at module scope through the ADE's host
				// port, and throws rather than guessing when nothing is installed.
				// The ADE's own startup installs this; a host that wants only the
				// preferences has to do it itself.
				if (!orca.hasAppEnvironment()) {
					orca.setAppEnvironment(new orca.ElectronAppEnvironment());
				}
				// Opened against the active profile's data file, the way the ADE's
				// own startup does. Without it `new Store()` opens the file beside
				// the user data root instead, which nothing running ever reads — so
				// every setting saved and none of them took effect.
				this._ownStore = new orca.Store({ dataFile: orca.ensureActiveKinguProfile().dataFile });
			} catch (error) {
				this.logService.error('[kingu-settings] could not open the ADE store', error);
				return undefined;
			}
		}
		return this._ownStore;
	}

	private _read(): Record<string, unknown> {
		const store = this._orcaStore();
		if (!store) {
			return {};
		}
		const settings = store.getSettings() as Record<string, unknown>;
		const bridged: Record<string, unknown> = {};
		for (const setting of KINGU_BRIDGED_SETTINGS) {
			if (settings[setting.key] !== undefined) {
				bridged[setting.id] = settings[setting.key];
			}
		}
		return bridged;
	}

	/**
	 * Applies what the Settings editor changed.
	 *
	 * `notifyListeners` is on because the ADE's own surfaces are listening: a
	 * write that skipped them would change the stored value and leave every
	 * running part of the ADE acting on the old one until a restart.
	 */
	private _write(updates: Record<string, unknown>): boolean {
		const store = this._orcaStore();
		if (!store) {
			return false;
		}
		const byId = new Map(KINGU_BRIDGED_SETTINGS.map(setting => [setting.id, setting]));
		const forStore: Record<string, unknown> = {};
		for (const [id, value] of Object.entries(updates)) {
			const setting = byId.get(id);
			if (!setting) {
				this.logService.warn(`[kingu-settings] refused an unbridged key: ${id}`);
				continue;
			}
			forStore[setting.key] = value;
		}
		if (Object.keys(forStore).length === 0) {
			return false;
		}
		try {
			store.updateSettings(forStore, { notifyListeners: true });
			return true;
		} catch (error) {
			this.logService.error('[kingu-settings] could not write to the ADE store', error);
			return false;
		}
	}

	/**
	 * Forwards the ADE's own changes back, so the two never disagree.
	 *
	 * Without this the Settings editor would be write-only: a setting changed
	 * inside the ADE — by its own UI, or by a migration on startup — would leave
	 * Settings showing the value it had when the window opened.
	 */
	private _ensureListening(): void {
		if (this._listening) {
			return;
		}
		const store = this._orcaStore();
		if (!store) {
			// No store yet. Left unlatched deliberately: the next subscriber tries
			// again, and by then the ADE's ready phase has run.
			return;
		}
		this._listening = true;
		const dispose = store.onSettingsChanged(() => this._onDidChange.fire(this._read()));
		this._register({ dispose });
	}
}

/** The three methods this needs from the ADE's store, and no more of its surface. */
interface IOrcaSettingsStore {
	getSettings(): unknown;
	updateSettings(updates: Record<string, unknown>, options: { notifyListeners?: boolean }): unknown;
	onSettingsChanged(listener: () => void): () => void;
}

/** What this file reaches for in the ADE's bundle. */
interface IOrcaSettingsModule {
	readonly mainProcessState: unknown;
	readonly Store: new (options: { dataFile: string }) => IOrcaSettingsStore;
	readonly hasAppEnvironment: () => boolean;
	readonly setAppEnvironment: (environment: object) => void;
	readonly ElectronAppEnvironment: new () => object;
	readonly ensureActiveKinguProfile: () => { readonly dataFile: string };
}
