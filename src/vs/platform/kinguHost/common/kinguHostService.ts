/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { KinguQuotaProvider } from './kinguQuotaProviders.js';
import { KinguQuotaResult } from './kinguRateLimits.js';
import { IKinguListeningPort } from './kinguHostPorts.js';

/** What the app is holding, and what is holding it. */
export interface IKinguMemoryReading {
	readonly total: number;
	/** By process kind, largest first. */
	readonly byKind: readonly { readonly kind: string; readonly bytes: number }[];
}

export const IKinguHostService = createDecorator<IKinguHostService>('kinguHostService');

/**
 * What a window can only learn by asking the process that owns the machine.
 *
 * Three unrelated-looking readings live together because they share one reason
 * to be here rather than in the window: a renderer is a `vscode-file://` origin
 * that cannot reach a provider's API, it sees only its own heap, and it has no
 * way to enumerate sockets. All three are answered over one channel.
 *
 * Nothing here signs anything in, refreshes a token, or writes to a credential
 * store: it reads what the agents' own CLIs already left on disk and asks their
 * issuers.
 */
export interface IKinguHostService {
	readonly _serviceBrand: undefined;

	/** Fires when a refresh changes what {@link quotas} returns. */
	readonly onDidChange: Event<void>;

	/** The last quota reading per provider; absent until one has been taken. */
	readonly quotas: ReadonlyMap<KinguQuotaProvider, KinguQuotaResult>;

	/** Reads every quota again now. Safe to call often; concurrent calls share one request. */
	refresh(): Promise<void>;

	/** What the app is holding across all of its processes, when that is knowable. */
	readMemory(): Promise<IKinguMemoryReading | undefined>;

	/** The TCP ports something on this machine is listening on. */
	readListeningPorts(): Promise<readonly IKinguListeningPort[]>;

	/**
	 * Where each of these commands is installed, for the ones that are.
	 *
	 * Absent from the result means "not found on PATH or in a place an installer
	 * puts one", which is not quite the same as "not installed" — an agent
	 * reachable only through a shell alias or a version manager this does not
	 * know is invisible. Presented as what it is.
	 */
	findExecutables(commands: readonly string[]): Promise<Readonly<Record<string, string>>>;
}
