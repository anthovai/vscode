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

/** Gemini's tokens since local midnight, from the chats its CLI records. */
export interface IKinguGeminiUsage {
	readonly inputTokens: number;
	/** Output and thinking tokens. */
	readonly outputTokens: number;
	/** The part of `inputTokens` served from cache. */
	readonly cachedTokens: number;
	readonly replies: number;
	/** Local midnight, as epoch milliseconds. */
	readonly since: number;
}

/** The Claude login in use, as Claude Code records it. */
export interface IKinguClaudeAccount {
	readonly email: string;
	/** `Claude Team`, `Claude Max 5x`, … when the record names it. */
	readonly plan?: string;
	readonly organization?: string;
}

/** An agent CLI's sign-in, as the CLI itself reports it (`agentAccount`). */
export interface IKinguAgentAccount {
	readonly signedIn: boolean;
	readonly email?: string;
	/** The plan, as the CLI names it (Cursor's `Pro+`). */
	readonly plan?: string;
	/** How it signs in, where there is no account to name: `API key`, `Google, OpenAI`. */
	readonly method?: string;
	/** Tokens since local midnight, where the CLI records them. */
	readonly tokensToday?: number;
}
