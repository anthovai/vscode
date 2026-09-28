/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IKinguOrcaService = createDecorator<IKinguOrcaService>('kinguOrcaService');

/**
 * The ADE's engine, as the Agents Window sees it.
 *
 * The same calls the ADE's own renderer makes through `window.api`, addressed by
 * the ADE's channel names. A surface built on this does not reimplement the
 * ADE; it is another client of it.
 */
export interface IKinguOrcaService {
	readonly _serviceBrand: undefined;

	/** Calls one of the ADE's handlers, e.g. `invoke('rateLimits:get')`. */
	invoke<T>(channel: string, ...args: unknown[]): Promise<T>;

	/** What the ADE pushes on `channel`, e.g. `onPush('rateLimits:update')`. */
	onPush(channel: string): Event<readonly unknown[]>;
}
