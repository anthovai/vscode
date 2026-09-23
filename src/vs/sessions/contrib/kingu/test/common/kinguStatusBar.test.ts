/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { displayedUsagePercent, formatRateLimit, formatResetDuration, formatWindow, nextResetTickDelay, readRateLimitFromAccount } from '../../common/kinguStatusBar.js';

suite('Kingu status bar', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('readRateLimitFromAccount', () => {

		test('reads a quota the account states', () => {
			const limit = readRateLimitFromAccount({ rateLimit: { usedPercent: 58, windowDurationMins: 300, resetsAt: 1_800_000_000_000 } });
			assert.deepStrictEqual(limit, { usedPercent: 58, windowDurationMins: 300, resetsAt: 1_800_000_000_000 });
		});

		test('refuses a percentage that is not one', () => {
			// A gauge is read at a glance and never questioned, so a value outside the
			// range must produce no gauge rather than a confident wrong one.
			assert.strictEqual(readRateLimitFromAccount({ rateLimit: { usedPercent: -1 } }), undefined);
			assert.strictEqual(readRateLimitFromAccount({ rateLimit: { usedPercent: 101 } }), undefined);
			assert.strictEqual(readRateLimitFromAccount({ rateLimit: { usedPercent: Number.NaN } }), undefined);
		});

		test('reports none when the account states no quota', () => {
			assert.strictEqual(readRateLimitFromAccount(undefined), undefined);
			assert.strictEqual(readRateLimitFromAccount({}), undefined);
		});

		test('keeps the percentage when only the window is missing', () => {
			const limit = readRateLimitFromAccount({ rateLimit: { usedPercent: 40, windowDurationMins: 0 } });
			assert.strictEqual(limit?.usedPercent, 40);
			assert.strictEqual(limit?.windowDurationMins, undefined);
		});
	});

	suite('formatWindow', () => {

		test('says the unit a person would say', () => {
			assert.strictEqual(formatWindow(300), '5h');
			assert.strictEqual(formatWindow(10_080), 'wk');
			assert.strictEqual(formatWindow(1_440), 'd');
			assert.strictEqual(formatWindow(30), '30m');
		});

		test('counts the unit when there is more than one', () => {
			assert.strictEqual(formatWindow(20_160), '2wk');
			assert.strictEqual(formatWindow(4_320), '3d');
		});
	});

	suite('formatRateLimit', () => {

		test('counts down to the reset rather than restating the window length', () => {
			const now = 1_000_000_000_000;
			assert.strictEqual(
				formatRateLimit({ usedPercent: 58, windowDurationMins: 300, resetsAt: now + (3 * 3_600_000) + (54 * 60_000) }, 'used', now),
				'58% used 3h 54m');
		});

		test('falls back to the window length when no reset time was reported', () => {
			assert.strictEqual(formatRateLimit({ usedPercent: 58, windowDurationMins: 300, resetsAt: undefined }), '58% used 5h');
			assert.strictEqual(formatRateLimit({ usedPercent: 41, windowDurationMins: 10_080, resetsAt: undefined }), '41% used wk');
		});

		test('says which way it counts even with nothing else known', () => {
			assert.strictEqual(formatRateLimit({ usedPercent: 52, windowDurationMins: undefined, resetsAt: undefined }), '52% used');
			assert.strictEqual(formatRateLimit({ usedPercent: 52, windowDurationMins: undefined, resetsAt: undefined }, 'remaining'), '48% left');
		});

		test('rounds rather than showing a fraction of a percent', () => {
			assert.strictEqual(formatRateLimit({ usedPercent: 57.6, windowDurationMins: undefined, resetsAt: undefined }), '58% used');
		});
	});

	suite('displayedUsagePercent', () => {

		test('rounds before taking the complement, so the two modes agree', () => {
			// Rounding last would make these 80 and 79 — a point of drift between
			// the label and the bar that fills from the same number.
			assert.strictEqual(displayedUsagePercent(20.5, 'used'), 21);
			assert.strictEqual(displayedUsagePercent(20.5, 'remaining'), 79);
		});

		test('clamps, and reads an unusable number as empty rather than full', () => {
			assert.deepStrictEqual(
				[displayedUsagePercent(140, 'used'), displayedUsagePercent(-5, 'used'), displayedUsagePercent(NaN, 'remaining')],
				[100, 0, 0]);
		});
	});

	suite('formatResetDuration', () => {

		test('floors, so it never promises a reset sooner than it happens', () => {
			assert.deepStrictEqual(
				[
					formatResetDuration(47 * 60_000 + 59_000),
					formatResetDuration(3 * 3_600_000 + 54 * 60_000),
					formatResetDuration(2 * 3_600_000),
					formatResetDuration(6 * 86_400_000 + 7 * 3_600_000),
					formatResetDuration(3 * 86_400_000),
					formatResetDuration(0),
				],
				['47m', '3h 54m', '2h', '6d 7h', '3d', 'now']);
		});
	});

	suite('nextResetTickDelay', () => {

		test('wakes just past the next boundary, not every second', () => {
			const now = 1_000_000_000_000;
			// 90s out: the label reads `1m` and flips to `0m` 30s from now.
			assert.strictEqual(nextResetTickDelay(now, [now + 90_000]), 30_001);
		});

		test('ticks hourly past a day, because that is when the label moves', () => {
			const now = 1_000_000_000_000;
			assert.strictEqual(nextResetTickDelay(now, [now + 86_400_000 + 90_000]), 90_001);
		});

		test('takes the soonest, and ignores windows already reset', () => {
			const now = 1_000_000_000_000;
			assert.strictEqual(nextResetTickDelay(now, [now - 5_000, now + 90_000, now + 20_000]), 20_001);
			assert.strictEqual(nextResetTickDelay(now, [now - 5_000]), undefined);
		});
	});
});
