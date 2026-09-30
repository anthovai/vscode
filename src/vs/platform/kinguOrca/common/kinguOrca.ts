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

/**
 * Where Kingu cloud is served (`kingu-intelligence/cloud`, `deploy/compose.prod.yaml`):
 * sign-in, the account and its plan, Artifacts and Skills sharing, all from one
 * origin. `KINGU_CLOUD_URL` overrides it, for a local cloud in development.
 */
export const KINGU_CLOUD_ORIGIN = 'https://kingu.anthovai.com';
