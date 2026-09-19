/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatRateLimit, formatWindow, readRateLimitFromAccount } from '../../common/kinguStatusBar.js';

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

		test('shows the window, because half of five hours is not half of a week', () => {
			assert.strictEqual(formatRateLimit({ usedPercent: 58, windowDurationMins: 300, resetsAt: undefined }), '58% 5h');
			assert.strictEqual(formatRateLimit({ usedPercent: 41, windowDurationMins: 10_080, resetsAt: undefined }), '41% wk');
		});

		test('shows the percentage alone when the window is unknown', () => {
			assert.strictEqual(formatRateLimit({ usedPercent: 52, windowDurationMins: undefined, resetsAt: undefined }), '52%');
		});

		test('rounds rather than showing a fraction of a percent', () => {
			assert.strictEqual(formatRateLimit({ usedPercent: 57.6, windowDurationMins: undefined, resetsAt: undefined }), '58%');
		});
	});
});
