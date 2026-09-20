/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** How much of one quota window an account has spent. */
export interface IKinguRateLimit {
	/** 0–100. */
	readonly usedPercent: number;
	/** The window's length, when the account states one. */
	readonly windowDurationMins: number | undefined;
	/** Epoch milliseconds, when the account states one. */
	readonly resetsAt: number | undefined;
}

/**
 * The main-process channel answering what only the main process can see.
 *
 * Named in common so a window can address it without importing the module that
 * serves it, which pulls in `electron`.
 */
export const KINGU_HOST_CHANNEL_NAME = 'kinguHost';
