/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export const KINGU_ORCA_CHANNEL_NAME = 'kinguOrca';

/** A message the ADE's engine pushed, as its own renderer would have received it. */
export interface IKinguOrcaPush {
	readonly channel: string;
	readonly args: readonly unknown[];
}
