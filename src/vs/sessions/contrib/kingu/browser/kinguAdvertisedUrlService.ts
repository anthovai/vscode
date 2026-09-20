/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IKinguAdvertisedUrl, KinguAdvertisedUrlCache, readAdvertisedUrls } from '../common/kinguAdvertisedUrls.js';

export const IKinguAdvertisedUrlService = createDecorator<IKinguAdvertisedUrlService>('kinguAdvertisedUrlService');

export interface IKinguAdvertisedUrlService {
	readonly _serviceBrand: undefined;

	/** Fires when a port's best address changes. */
	readonly onDidChange: import('../../../../base/common/event.js').Event<void>;

	/** The address announced for a port, when one was. */
	get(port: number): IKinguAdvertisedUrl | undefined;

	/** Forgets ports nothing is listening on any more. */
	retain(listening: ReadonlySet<number>): void;
}

/**
 * Watches what the terminals say, for the addresses dev servers announce.
 *
 * A port number is not enough to open a dev server. A Vite app prints
 * `http://localhost:5173/`, a Rails app may print a path, a project with a
 * local domain prints that name, and a server behind TLS prints `https` — none
 * of which can be recovered from the socket. The one place all of it is stated
 * is the line the server printed when it came up, so that is what this reads.
 *
 * It listens to `onLineData`, which the terminal emits already stripped of
 * escape sequences and already unwrapped. The ADE buffers raw PTY chunks and
 * undoes ANSI, OSC and cursor movement itself to get here; that whole layer is
 * absent because the terminal in this window has already done it.
 *
 * Nothing is persisted. An address is only true while the process that printed
 * it is still listening, and a URL restored from a previous run of the app
 * would name a server that is gone.
 */
export class KinguAdvertisedUrlService extends Disposable implements IKinguAdvertisedUrlService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _cache = new KinguAdvertisedUrlCache();
	/** One listener per terminal, dropped with the terminal. */
	private readonly _watched = this._register(new DisposableMap<ITerminalInstance>());

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super();
		this._register(this._terminalService.onDidChangeInstances(() => this._watchAll()));
		this._watchAll();
	}

	get(port: number): IKinguAdvertisedUrl | undefined {
		return this._cache.get(port);
	}

	retain(listening: ReadonlySet<number>): void {
		this._cache.retain(listening);
	}

	private _watchAll(): void {
		for (const instance of this._terminalService.instances) {
			if (!this._watched.has(instance)) {
				this._watched.set(instance, instance.onLineData(line => this._read(line)));
			}
		}
		// A terminal that has gone keeps nothing: its listener is disposed, and the
		// addresses it announced are dropped by `retain` once the port stops
		// answering, which is the only evidence that actually says the server died.
		for (const instance of this._watched.keys()) {
			if (!this._terminalService.instances.includes(instance)) {
				this._watched.deleteAndDispose(instance);
			}
		}
	}

	private _read(line: string): void {
		if (this._cache.record(readAdvertisedUrls(line, Date.now())).length > 0) {
			this._onDidChange.fire();
		}
	}
}
