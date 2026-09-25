/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

/**
 * Kingu asks for an AI account, never a GitHub one: the agents run on the
 * user's own Claude or ChatGPT login, kept by the ADE's account service
 * (`claudeAccounts:*`, `codexAccounts:*`) exactly as the ADE's settings keep
 * them. Commands rather than a service so a window without the ADE (web) just
 * finds them missing.
 */

/** `kingu.ai.signIn(provider)`: runs the provider's own login and uses the new account. */
export const KINGU_AI_SIGN_IN_COMMAND_ID = 'kingu.ai.signIn';

/** `kingu.ai.accountStatus(provider)`: `IKinguAiAccountStatus`. */
export const KINGU_AI_ACCOUNT_STATUS_COMMAND_ID = 'kingu.ai.accountStatus';

/** `kingu.ai.agentAccounts()`: `IKinguAiAgentAccount[]`, one for each ACP agent this machine runs. */
export const KINGU_AI_AGENT_ACCOUNTS_COMMAND_ID = 'kingu.ai.agentAccounts';

/**
 * `kingu.ai.signInInTerminal(agentId)`: runs the agent CLI's own sign-in in a
 * terminal, the way the ADE signs its terminal agents in.
 */
export const KINGU_AI_SIGN_IN_IN_TERMINAL_COMMAND_ID = 'kingu.ai.signInInTerminal';

/** An ACP agent this machine runs, as the account panel shows it. */
export interface IKinguAiAgentAccount {
	readonly id: string;
	readonly displayName: string;
	/** Whether the agent offers models of its own, rather than only its configured one (which it does while signed out). */
	readonly signedIn: boolean;
	readonly modelCount: number;
}

export type KinguAiProvider = 'claude' | 'codex' | 'gemini';

export const KINGU_AI_PROVIDERS: readonly KinguAiProvider[] = ['claude', 'codex', 'gemini'];

export interface IKinguAiAccountStatus {
	readonly signedIn: boolean;
	readonly email?: string;
	/**
	 * A sign-in still worth offering while signed in, by its label: Gemini on an
	 * API key can move to a Google login, whose quota the usage meter shows.
	 */
	readonly signInLabel?: string;
}

/** Whether each provider has an account in use, for menus. */
export const KinguAiSignedInContext: Readonly<Record<KinguAiProvider, RawContextKey<boolean>>> = {
	claude: new RawContextKey<boolean>('kinguAiClaudeSignedIn', false, localize('kinguAiClaudeSignedIn', "Whether a Claude account is in use")),
	codex: new RawContextKey<boolean>('kinguAiCodexSignedIn', false, localize('kinguAiCodexSignedIn', "Whether a ChatGPT account is in use")),
	gemini: new RawContextKey<boolean>('kinguAiGeminiSignedIn', false, localize('kinguAiGeminiSignedIn', "Whether Gemini is signed in")),
};

/** The account's name as the reader knows it: Claude, and ChatGPT for Codex. */
export function kinguAiProviderLabel(provider: KinguAiProvider): string {
	switch (provider) {
		case 'claude': return localize('kingu.ai.claude', "Claude");
		case 'codex': return localize('kingu.ai.chatgpt', "ChatGPT");
		case 'gemini': return localize('kingu.ai.gemini', "Gemini");
	}
}

/** The agent host's agent that runs on each account. */
export function kinguAiAgentId(provider: KinguAiProvider): string {
	return provider;
}

export function isKinguAiProvider(value: unknown): value is KinguAiProvider {
	return value === 'claude' || value === 'codex' || value === 'gemini';
}
