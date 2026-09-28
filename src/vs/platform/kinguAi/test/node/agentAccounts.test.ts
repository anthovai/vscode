/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseCursorAbout, parseOpenCodeAuthList, qwenTokensToday } from '../../node/agentAccounts.js';

suite('agentAccounts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads Cursor\'s account and plan from `about`, and a missing account as signed out', () => {
		const about = [
			'About Cursor CLI',
			'',
			'CLI Version         2026.09.26-dd393fe',
			'Model               Auto',
			'Subscription Tier   Pro+',
			'User Email          person@example.com',
		].join('\r\n');
		assert.deepStrictEqual({
			signedIn: parseCursorAbout(about),
			signedOut: parseCursorAbout('About Cursor CLI\n\nUser Email          Not logged in\n'),
		}, {
			signedIn: { signedIn: true, email: 'person@example.com', plan: 'Pro+' },
			signedOut: { signedIn: false },
		});
	});

	test('reads the providers `opencode auth list` names, credentials and environment keys alike', () => {
		const list = [
			'\u001b[90mT\u001b[39m  Environment',
			'|',
			'•  Google \u001b[90mGEMINI_API_KEY',
			'|',
			'•  OpenAI \u001b[90mOPENAI_API_KEY',
			'|',
			'—  2 environment variables',
		].join('\n');
		assert.deepStrictEqual({
			keys: parseOpenCodeAuthList(list),
			none: parseOpenCodeAuthList('T  Credentials\n|\n—  0 credentials\n'),
		}, {
			keys: { signedIn: true, method: 'Google, OpenAI' },
			none: { signedIn: false },
		});
	});

	test('adds up the tokens of Qwen Code\'s sessions since midnight', () => {
		const now = new Date(2026, 8, 28, 15, 0, 0);
		const today = new Date(2026, 8, 28, 9, 0, 0).getTime();
		const yesterday = new Date(2026, 8, 27, 23, 0, 0).getTime();
		const records = [
			JSON.stringify({ timestamp: yesterday, models: { 'gpt-5.5': { totalTokens: 500 } } }),
			JSON.stringify({ timestamp: today, models: { 'gpt-5.5': { totalTokens: 120 }, 'qwen3-coder': { totalTokens: 30 } } }),
			'not json',
			'',
		].join('\n');
		assert.strictEqual(qwenTokensToday(records, now), 150);
	});
});
