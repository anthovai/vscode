/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { IKinguClaudeAccount } from '../common/kinguAi.js';

/** How Claude Code names an organization's plan in `oauthAccount.organizationType`. */
const PLAN_NAMES: Readonly<Record<string, string>> = {
	'claude_pro': 'Claude Pro',
	'claude_max': 'Claude Max',
	'claude_team': 'Claude Team',
	'claude_enterprise': 'Claude Enterprise',
};

/**
 * The Claude login in use, as Claude Code records it in `~/.claude.json`
 * (`oauthAccount`): the account's email and its plan. The ADE materializes the
 * account it has selected into the same place, so this is the account the
 * Claude agent runs on either way. `undefined` without a Claude login.
 */
export async function readClaudeAccount(): Promise<IKinguClaudeAccount | undefined> {
	const configDir = process.env.CLAUDE_CONFIG_DIR;
	const path = configDir ? join(configDir, '.claude.json') : join(homedir(), '.claude.json');
	let account: { readonly emailAddress?: unknown; readonly organizationType?: unknown; readonly organizationName?: unknown; readonly userRateLimitTier?: unknown } | undefined;
	try {
		account = JSON.parse(await fs.readFile(path, 'utf8'))?.oauthAccount;
	} catch {
		return undefined;
	}
	if (!account || typeof account.emailAddress !== 'string') {
		return undefined;
	}
	const organizationType = typeof account.organizationType === 'string' ? account.organizationType : undefined;
	// A personal subscription reports its tier on the user (`default_claude_max_5x`).
	const tier = typeof account.userRateLimitTier === 'string' ? /claude_(?<plan>pro|max)(?:_(?<multiple>\d+x))?/.exec(account.userRateLimitTier)?.groups : undefined;
	const plan = (organizationType && PLAN_NAMES[organizationType])
		?? (tier ? `Claude ${tier.plan === 'max' ? 'Max' : 'Pro'}${tier.multiple ? ` ${tier.multiple}` : ''}` : undefined);
	return {
		email: account.emailAddress,
		plan,
		organization: typeof account.organizationName === 'string' ? account.organizationName : undefined,
	};
}
