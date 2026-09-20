/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	CLAUDE_SESSION_WINDOW_MINUTES,
	CLAUDE_WEEKLY_WINDOW_MINUTES,
	problemForStatus,
	readClaudeAccessToken,
	readClaudeQuota,
} from '../../../../../platform/kinguHost/common/kinguRateLimits.js';

const NOW = 1_800_000_000_000;

suite('Kingu rate limits', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('readClaudeAccessToken', () => {

		test('reads the token the CLI stored', () => {
			const json = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: NOW + 60_000 } });
			assert.deepStrictEqual(readClaudeAccessToken(json, NOW), { ok: true, token: 'tok' });
		});

		test('treats an expired token as expired rather than sending it', () => {
			// The endpoint would reject it, and renewing it means writing into a
			// credential store this does not own.
			const json = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: NOW - 1 } });
			assert.deepStrictEqual(readClaudeAccessToken(json, NOW), { ok: false, problem: 'expiredCredentials' });
		});

		test('accepts a token with no stated expiry', () => {
			const json = JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } });
			assert.strictEqual(readClaudeAccessToken(json, NOW).ok, true);
		});

		test('reports no credentials for a file that holds none', () => {
			assert.deepStrictEqual(readClaudeAccessToken('{}', NOW), { ok: false, problem: 'noCredentials' });
			assert.deepStrictEqual(readClaudeAccessToken('not json', NOW), { ok: false, problem: 'noCredentials' });
			assert.deepStrictEqual(readClaudeAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: '  ' } }), NOW), { ok: false, problem: 'noCredentials' });
		});

		test('ignores the other tokens the same file holds', () => {
			// The file also stores MCP server tokens, which are not this account's.
			const json = JSON.stringify({ mcpOAuth: { 'some-server': { accessToken: 'other' } } });
			assert.deepStrictEqual(readClaudeAccessToken(json, NOW), { ok: false, problem: 'noCredentials' });
		});
	});

	suite('readClaudeQuota', () => {

		test('reads both windows and labels them by length', () => {
			const quota = readClaudeQuota({
				five_hour: { utilization: 58, resets_at: '2026-09-20T12:00:00Z' },
				seven_day: { utilization: 41 },
			}, NOW);
			assert.strictEqual(quota.session?.usedPercent, 58);
			assert.strictEqual(quota.session?.windowDurationMins, CLAUDE_SESSION_WINDOW_MINUTES);
			assert.strictEqual(quota.weekly?.usedPercent, 41);
			assert.strictEqual(quota.weekly?.windowDurationMins, CLAUDE_WEEKLY_WINDOW_MINUTES);
			assert.strictEqual(quota.updatedAt, NOW);
		});

		test('accepts either spelling of the percentage', () => {
			assert.strictEqual(readClaudeQuota({ five_hour: { used_percentage: 12 } }, NOW).session?.usedPercent, 12);
		});

		test('a window reporting no percentage is absent, not zero', () => {
			// "No quota used" and "no quota reported" are different answers.
			assert.strictEqual(readClaudeQuota({ five_hour: {} }, NOW).session, undefined);
			assert.strictEqual(readClaudeQuota({}, NOW).session, undefined);
		});

		test('clamps past full, which reads as a bug rather than as being out', () => {
			assert.strictEqual(readClaudeQuota({ five_hour: { utilization: 140 } }, NOW).session?.usedPercent, 100);
			assert.strictEqual(readClaudeQuota({ five_hour: { utilization: -5 } }, NOW).session?.usedPercent, 0);
		});

		test('reads a reset time in any of the shapes the endpoint sends', () => {
			assert.strictEqual(readClaudeQuota({ five_hour: { utilization: 1, resets_at: 1_800_000_000 } }, NOW).session?.resetsAt, 1_800_000_000_000);
			assert.strictEqual(readClaudeQuota({ five_hour: { utilization: 1, resets_at: 1_800_000_000_000 } }, NOW).session?.resetsAt, 1_800_000_000_000);
			assert.strictEqual(readClaudeQuota({ five_hour: { utilization: 1, resets_at: '2026-01-01T00:00:00Z' } }, NOW).session?.resetsAt, Date.parse('2026-01-01T00:00:00Z'));
		});

		test('an unreadable reset time leaves the window without one', () => {
			assert.strictEqual(readClaudeQuota({ five_hour: { utilization: 1, resets_at: 'soon' } }, NOW).session?.resetsAt, undefined);
			assert.strictEqual(readClaudeQuota({ five_hour: { utilization: 1 } }, NOW).session?.resetsAt, undefined);
		});

		test('survives a body that is not what was expected', () => {
			assert.deepStrictEqual(readClaudeQuota('nope', NOW), { session: undefined, weekly: undefined, updatedAt: NOW });
			assert.deepStrictEqual(readClaudeQuota(null, NOW), { session: undefined, weekly: undefined, updatedAt: NOW });
		});
	});

	test('problemForStatus separates a rejected token from an unreachable service', () => {
		assert.strictEqual(problemForStatus(401), 'unauthorized');
		assert.strictEqual(problemForStatus(403), 'unauthorized');
		assert.strictEqual(problemForStatus(500), 'unavailable');
		assert.strictEqual(problemForStatus(429), 'unavailable');
	});
});
