/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** The main-process channel for the AI accounts the ADE does not keep (Gemini). */
export const KINGU_AI_CHANNEL_NAME = 'kinguAi';

/** How Gemini is signed in, as its CLI records it in `~/.gemini`. */
export interface IKinguGeminiStatus {
	readonly signedIn: boolean;
	/** `oauth-personal`, `gemini-api-key`, `vertex-ai`, … as the CLI names it. */
	readonly method?: string;
	/** The Google account, for a Google login. */
	readonly email?: string;
	/** Whether a Gemini CLI is installed at all. */
	readonly installed: boolean;
}
