/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatKinguAiUsage, IKinguAiAccountRow, summarizeKinguAiAccounts } from '../../common/kinguAiAccountSummary.js';

const row = (id: string, signedIn: boolean): IKinguAiAccountRow => ({ id, label: id, signedIn, signIn: 'provider' });

suite('kinguAiAccountSummary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats a limit with its reset, or today’s tokens', () => {
		const now = Date.parse('2026-09-26T00:00:00Z');
		assert.deepStrictEqual([
			formatKinguAiUsage({ usedPercent: 21.4, resetsAt: now + 3 * 3_600_000 }, now),
			formatKinguAiUsage({ usedPercent: 8, resetsAt: now + 28 * 24 * 3_600_000 }, now),
			formatKinguAiUsage({ usedPercent: 50 }, now),
			formatKinguAiUsage({ tokensToday: 561_300 }, now),
			formatKinguAiUsage({ tokensToday: 0 }, now),
			formatKinguAiUsage(undefined, now),
		], [
			'21% used, resets in 3 hrs',
			'8% used, resets in 28 days',
			'50% used',
			'561.3k tokens today',
			'0 tokens today',
			undefined,
		]);
	});

	test('sums up the accounts in one line', () => {
		assert.deepStrictEqual([
			summarizeKinguAiAccounts([]),
			summarizeKinguAiAccounts([row('claude', true)]),
			summarizeKinguAiAccounts([row('claude', true), row('codex', true), row('gemini', true)]),
			summarizeKinguAiAccounts([row('claude', true), row('codex', true), row('gemini', true), row('qwen-code', false)]),
		], [
			'No AI agents found on this machine',
			'1 signed in',
			'3 signed in',
			'3 signed in · 1 to sign in',
		]);
	});
});
