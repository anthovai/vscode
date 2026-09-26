/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import {
	IKinguAiAccountStatus,
	IKinguAiAgentAccount,
	IKinguAiUsage,
	KINGU_AI_ACCOUNT_STATUS_COMMAND_ID,
	KINGU_AI_AGENT_ACCOUNTS_COMMAND_ID,
	KINGU_AI_PROVIDERS,
	kinguAiProviderLabel,
} from '../../../../workbench/contrib/kingu/common/kinguAiAccounts.js';

/** One AI on the Signed-in AI list, whatever kind of account it has. */
export interface IKinguAiAccountRow {
	/** `claude`, `codex`, `gemini`, or an ACP agent's id. */
	readonly id: string;
	readonly label: string;
	readonly signedIn: boolean;
	readonly email?: string;
	readonly plan?: string;
	readonly usage?: IKinguAiUsage;
	/** How it signs in: through the ADE's login, or the agent CLI's own in a terminal. */
	readonly signIn: 'provider' | 'terminal';
}

function relativeHours(resetsAt: number, now: number): string {
	const hours = Math.max(0, Math.round((resetsAt - now) / 3_600_000));
	if (hours < 1) {
		return localize('kingu.aiAccounts.underHour', "under an hour");
	}
	if (hours < 48) {
		return hours === 1 ? localize('kingu.aiAccounts.oneHour', "1 hr") : localize('kingu.aiAccounts.hours', "{0} hrs", hours);
	}
	return localize('kingu.aiAccounts.days', "{0} days", Math.round(hours / 24));
}

/** What an account has used, in one line: a limit's share and when it resets, or today's tokens. */
export function formatKinguAiUsage(usage: IKinguAiUsage | undefined, now: number): string | undefined {
	if (!usage) {
		return undefined;
	}
	if (usage.usedPercent !== undefined) {
		const percent = Math.round(usage.usedPercent);
		return usage.resetsAt
			? localize('kingu.aiAccounts.usedResets', "{0}% used, resets in {1}", percent, relativeHours(usage.resetsAt, now))
			: localize('kingu.aiAccounts.used', "{0}% used", percent);
	}
	if (usage.tokensToday !== undefined) {
		const tokens = usage.tokensToday;
		const text = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
		return localize('kingu.aiAccounts.tokensToday', "{0} tokens today", text);
	}
	return undefined;
}

/**
 * The account panel's one line for every AI account: how many are signed in
 * and how many still ask to be; the list itself lives in Settings.
 */
export function summarizeKinguAiAccounts(rows: readonly IKinguAiAccountRow[]): string {
	const signedIn = rows.filter(row => row.signedIn).length;
	const waiting = rows.length - signedIn;
	if (rows.length === 0) {
		return localize('kingu.aiAccounts.none', "No AI agents found on this machine");
	}
	if (waiting === 0) {
		return signedIn === 1 ? localize('kingu.aiAccounts.oneSignedIn', "1 signed in") : localize('kingu.aiAccounts.allSignedIn', "{0} signed in", signedIn);
	}
	return localize('kingu.aiAccounts.signedInAndWaiting', "{0} signed in · {1} to sign in", signedIn, waiting);
}

/**
 * Every AI this machine can run and whether it is signed in: Claude, ChatGPT
 * (Codex) and Gemini through the ADE's accounts, and each ACP agent (OpenCode,
 * Qwen Code…) by its own CLI. Empty where the commands are not registered.
 */
export async function loadKinguAiAccountRows(commandService: ICommandService): Promise<IKinguAiAccountRow[]> {
	if (!CommandsRegistry.getCommand(KINGU_AI_ACCOUNT_STATUS_COMMAND_ID)) {
		return [];
	}
	const [providers, agents] = await Promise.all([
		Promise.all(KINGU_AI_PROVIDERS.map(async provider => {
			const status = await commandService.executeCommand<IKinguAiAccountStatus>(KINGU_AI_ACCOUNT_STATUS_COMMAND_ID, provider).catch(() => undefined);
			return status ? { id: provider, label: kinguAiProviderLabel(provider), signedIn: status.signedIn, email: status.email, plan: status.plan, usage: status.usage, signIn: 'provider' as const } : undefined;
		})),
		commandService.executeCommand<IKinguAiAgentAccount[]>(KINGU_AI_AGENT_ACCOUNTS_COMMAND_ID).catch(() => undefined),
	]);
	return [
		...providers.filter((row): row is NonNullable<typeof row> => !!row),
		...(agents ?? []).map(agent => ({ id: agent.id, label: agent.displayName, signedIn: agent.signedIn, usage: agent.usage, signIn: 'terminal' as const })),
	];
}
