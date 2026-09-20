/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	KINGU_QUOTA_PROVIDER_LABELS,
	KINGU_QUOTA_PROVIDERS,
	KinguQuotaProvider,
	readDate,
	readGrokQuota,
	readGrokToken,
	readKimiQuota,
	readKimiToken,
	windowMinutes,
} from '../../../../../platform/kinguRateLimits/common/kinguQuotaProviders.js';

const NOW = 1_800_000_000_000;

suite('Kingu quota providers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every provider the bar iterates has a label', () => {
		for (const provider of KINGU_QUOTA_PROVIDERS) {
			assert.ok(KINGU_QUOTA_PROVIDER_LABELS[provider]?.trim(), `${provider} needs a label`);
		}
	});

	suite('Grok', () => {

		test('takes the first entry that carries a key, not the first entry', () => {
			// A stale issuer can precede the live one in auth.json.
			const auth = JSON.stringify({ stale: { key: '' }, live: { key: 'tok', userId: 'u1' } });
			assert.deepStrictEqual(readGrokToken(auth), { ok: true, token: 'tok', userId: 'u1' });
		});

		test('a token-less file is a signed-out CLI, not a broken one', () => {
			assert.deepStrictEqual(readGrokToken(JSON.stringify({ sessions: {} })), { ok: false, problem: 'noCredentials' });
			assert.deepStrictEqual(readGrokToken('not json'), { ok: false, problem: 'noCredentials' });
		});

		test('prefers the percentage the provider computed itself', () => {
			const quota = readGrokQuota({ creditUsagePercent: 37, used: { val: '9' }, monthlyLimit: { val: '10' } }, NOW);
			assert.strictEqual(quota.weekly?.usedPercent, 37);
		});

		test('falls back to spend against the limit', () => {
			const quota = readGrokQuota({ used: { val: '2.5' }, monthlyLimit: { val: '10' } }, NOW);
			assert.strictEqual(quota.weekly?.usedPercent, 25);
		});

		test('a zero or missing limit yields no window rather than a fabricated one', () => {
			// Dividing by it would give infinity, and reporting 0% would be a claim.
			assert.strictEqual(readGrokQuota({ used: { val: '5' }, monthlyLimit: { val: '0' } }, NOW).weekly, undefined);
			assert.strictEqual(readGrokQuota({ used: { val: '5' } }, NOW).weekly, undefined);
			assert.strictEqual(readGrokQuota({}, NOW).weekly, undefined);
		});

		test('reads the period end from either place it appears', () => {
			assert.strictEqual(readGrokQuota({ creditUsagePercent: 1, currentPeriod: { end: '2026-02-01T00:00:00Z' } }, NOW).weekly?.resetsAt, Date.parse('2026-02-01T00:00:00Z'));
			assert.strictEqual(readGrokQuota({ creditUsagePercent: 1, billingPeriodEnd: '2026-03-01T00:00:00Z' }, NOW).weekly?.resetsAt, Date.parse('2026-03-01T00:00:00Z'));
		});
	});

	suite('Kimi', () => {

		test('reads the stored token', () => {
			assert.deepStrictEqual(readKimiToken(JSON.stringify({ access_token: 'tok' }), NOW), { ok: true, token: 'tok' });
		});

		test('treats an expired token as expired', () => {
			const json = JSON.stringify({ access_token: 'tok', expires_at: '2020-01-01T00:00:00Z' });
			assert.deepStrictEqual(readKimiToken(json, NOW), { ok: false, problem: 'expiredCredentials' });
		});

		test('turns a limit and what is left into a percentage', () => {
			const quota = readKimiQuota({ limits: [{ limit: 100, remaining: 40, window: { duration: 5, timeUnit: 'HOUR' } }] }, NOW);
			assert.strictEqual(quota.session?.usedPercent, 60);
			assert.strictEqual(quota.session?.windowDurationMins, 300);
		});

		test('puts the shortest window first and the longest second', () => {
			const quota = readKimiQuota({
				limits: [
					{ limit: 10, remaining: 5, window: { duration: 7, timeUnit: 'DAY' } },
					{ limit: 10, remaining: 9, window: { duration: 5, timeUnit: 'HOUR' } },
				],
			}, NOW);
			assert.strictEqual(quota.session?.windowDurationMins, 300);
			assert.strictEqual(quota.weekly?.windowDurationMins, 10_080);
		});

		test('one window is one window, not a duplicate of itself', () => {
			const quota = readKimiQuota({ limits: [{ limit: 10, remaining: 1, window: { duration: 1, timeUnit: 'DAY' } }] }, NOW);
			assert.ok(quota.session);
			assert.strictEqual(quota.weekly, undefined);
		});

		test('skips an entry that cannot produce a percentage', () => {
			const quota = readKimiQuota({ limits: [{ limit: 0, remaining: 0, window: { duration: 1, timeUnit: 'HOUR' } }, { limit: 10, remaining: 10 }] }, NOW);
			assert.strictEqual(quota.session, undefined);
		});
	});

	suite('windowMinutes', () => {

		test('converts each unit the provider uses', () => {
			assert.strictEqual(windowMinutes({ duration: 30, timeUnit: 'MINUTE' }), 30);
			assert.strictEqual(windowMinutes({ duration: 5, timeUnit: 'hours' }), 300);
			assert.strictEqual(windowMinutes({ duration: 7, timeUnit: 'DAYS' }), 10_080);
			assert.strictEqual(windowMinutes({ duration: 1, timeUnit: 'WEEK' }), 10_080);
		});

		test('reports none for a unit or duration it cannot use', () => {
			assert.strictEqual(windowMinutes({ duration: 1, timeUnit: 'FORTNIGHT' }), undefined);
			assert.strictEqual(windowMinutes({ duration: 0, timeUnit: 'HOUR' }), undefined);
			assert.strictEqual(windowMinutes(undefined), undefined);
		});
	});

	test('readDate accepts the shapes these providers send', () => {
		assert.strictEqual(readDate(1_800_000_000), 1_800_000_000_000);
		assert.strictEqual(readDate(1_800_000_000_000), 1_800_000_000_000);
		assert.strictEqual(readDate('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
		assert.strictEqual(readDate('soon'), undefined);
		assert.strictEqual(readDate(undefined), undefined);
	});

	test('the provider ids are the ones the channel dispatches on', () => {
		assert.deepStrictEqual([...KINGU_QUOTA_PROVIDERS], [KinguQuotaProvider.Claude, KinguQuotaProvider.Grok, KinguQuotaProvider.Kimi]);
	});
});
