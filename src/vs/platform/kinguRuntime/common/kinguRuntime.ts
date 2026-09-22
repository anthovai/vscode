/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const KINGU_RUNTIME_CHANNEL_NAME = 'kinguRuntime';

/** Where the Kingu runtime lives once it is up, and how to reach its UI. */
export interface IKinguRuntimeEndpoint {
	/** The runtime's own socket, e.g. `ws://127.0.0.1:6810`. */
	readonly endpoint: string;
	/**
	 * The web client, already carrying the pairing offer.
	 *
	 * The code is in the URL rather than handed over separately because that is
	 * the import path the client already has: it reads `?code=` on startup and,
	 * for a `runtime`-scoped offer, saves it without asking. The alternative is
	 * showing the user a "Connect to Kingu" form for a server this window
	 * started itself, on loopback, seconds ago.
	 *
	 * The client clears the query off the address bar once it has imported it,
	 * because the payload carries the runtime's auth token.
	 */
	readonly webUrl: string;
	/** The runtime's own id, for logs. */
	readonly runtimeId: string;
}

export type KinguRuntimeStatus =
	| { readonly kind: 'stopped' }
	| { readonly kind: 'starting' }
	| { readonly kind: 'running'; readonly endpoint: IKinguRuntimeEndpoint }
	| { readonly kind: 'failed'; readonly message: string };

/** What a runtime needs to be found on disk. */
export interface IKinguRuntimePaths {
	/** `kingud.js`, the Electron-free runtime server. */
	readonly runtimeEntry: string;
	/** The directory holding the built web client (`web-index.html` and `assets/`). */
	readonly webRoot: string;
}

export const IKinguRuntimeService = createDecorator<IKinguRuntimeService>('kinguRuntimeService');

export interface IKinguRuntimeService {

	readonly _serviceBrand: undefined;

	/**
	 * Starts the runtime if it is not already up, and returns where it is.
	 *
	 * Idempotent: a second caller while the first is still booting waits on the
	 * same start rather than racing a second server onto another port.
	 */
	start(): Promise<IKinguRuntimeEndpoint>;

	/** Stops the runtime and the web server in front of it. */
	stop(): Promise<void>;

	status(): Promise<KinguRuntimeStatus>;
}

/**
 * The settings that say where the Kingu runtime was built.
 *
 * Paths rather than a bundled copy, deliberately and for now: the runtime and
 * the web client are built out of the `kingu-intelligence` checkout, and while
 * both repositories are moving together a stale vendored copy is worse than a
 * path that is occasionally wrong. Empty means "look beside this checkout".
 */
export const KINGU_RUNTIME_ENTRY_SETTING = 'kingu.runtime.entry';
export const KINGU_RUNTIME_WEB_ROOT_SETTING = 'kingu.runtime.webRoot';

/** Where a sibling `kingu-intelligence` build would be, relative to a checkout. */
export const KINGU_SIBLING_RUNTIME_ENTRY = ['kingu-intelligence', 'out', 'kingud', 'kingud.js'];
export const KINGU_SIBLING_WEB_ROOT = ['kingu-intelligence', 'out', 'web'];
