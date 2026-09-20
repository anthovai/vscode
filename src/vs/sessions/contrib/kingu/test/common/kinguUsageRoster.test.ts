/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KinguQuotaProvider } from '../../../../../platform/kinguHost/common/kinguQuotaProviders.js';
import { IKinguRateLimit } from '../../common/kinguStatusBar.js';
import {
	clampUsedPercent,
	displayedPercent,
	formatResetCountdown,
	IKinguUsageSource,
	KinguUsageSeverity,
	tightestWindow,
	usageRows,
	usageSeverity,
} from '../../common/kinguUsageRoster.js';

function limit(usedPercent: number, windowDurationMins?: number, resetsAt?: number): IKinguRateLimit {
	return { usedPercent, windowDurationMins, resetsAt };
}

function source(provider: KinguQuotaProvider, limits: IKinguRateLimit[], rest: Partial<IKinguUsageSource> = {}): IKinguUsageSource {
	return { provider, limits, problem: undefined, pending: false, ...rest };
}

suite('Kingu usage roster', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('percentages', () => {

		test('a reading outside the range is pulled into it rather than drawn', () => {
			// A gauge is glanced at and believed, so it never shows an impossible number.
			assert.strictEqual(clampUsedPercent(-20), 0);
			assert.strictEqual(clampUsedPercent(140), 100);
			// Not-a-number and infinity are both "unknown", and unknown is not a
			// full tank: they clamp to nothing rather than to the top of the range.
			assert.strictEqual(clampUsedPercent(Number.NaN), 0);
			assert.strictEqual(clampUsedPercent(Number.POSITIVE_INFINITY), 0);
		});

		test('rounding happens before the complement, so both directions agree', () => {
			// Rounding afterwards makes round(100 - 20.5) = 80 disagree with
			// 100 - round(20.5) = 79, and the same window reads differently
			// depending on which caller got there first.
			assert.strictEqual(displayedPercent(20.5, 'used'), 21);
			assert.strictEqual(displayedPercent(20.5, 'remaining'), 79);
			assert.strictEqual(displayedPercent(20.5, 'used') + displayedPercent(20.5, 'remaining'), 100);
		});

		test('nothing known is not a full tank', () => {
			assert.strictEqual(displayedPercent(Number.NaN, 'remaining'), 0);
		});

		test('severity changes where a number stops being background reading', () => {
			assert.strictEqual(usageSeverity(59), KinguUsageSeverity.Neutral);
			assert.strictEqual(usageSeverity(60), KinguUsageSeverity.Warning);
			assert.strictEqual(usageSeverity(79), KinguUsageSeverity.Warning);
			assert.strictEqual(usageSeverity(80), KinguUsageSeverity.Critical);
		});
	});

	suite('rows', () => {

		test('the agent nearest a wall is on top', () => {
			const rows = usageRows([
				source(KinguQuotaProvider.Claude, [limit(12, 300)]),
				source(KinguQuotaProvider.Grok, [limit(91, 300)]),
				source(KinguQuotaProvider.Kimi, [limit(44, 300)]),
			]);
			assert.deepStrictEqual(rows.map(row => row.provider), [
				KinguQuotaProvider.Grok,
				KinguQuotaProvider.Kimi,
				KinguQuotaProvider.Claude,
			]);
		});

		test('a row with nothing to report cannot outrank one with a reading', () => {
			// The panel is opened by someone asking how close they are; a provider
			// that reports nothing is never the answer to that question.
			const rows = usageRows([
				source(KinguQuotaProvider.Grok, [], { problem: 'noCredentials' }),
				source(KinguQuotaProvider.Claude, [limit(3, 300)]),
			]);
			assert.deepStrictEqual(rows.map(row => row.provider), [KinguQuotaProvider.Claude, KinguQuotaProvider.Grok]);
		});

		test('why there is no reading is kept, not flattened to "no data"', () => {
			const kinds = usageRows([
				source(KinguQuotaProvider.Claude, [], { problem: 'noCredentials' }),
				source(KinguQuotaProvider.Grok, [], { problem: 'expiredCredentials' }),
				source(KinguQuotaProvider.Kimi, [], { problem: 'unauthorized' }),
				source(KinguQuotaProvider.Gemini, [], { problem: 'unavailable' }),
				source(KinguQuotaProvider.Codex, [], { pending: true }),
			]).reduce<Record<string, string>>((all, row) => ({ ...all, [row.provider]: row.kind }), {});

			// An expired sign-in is the one case the user can fix, so it reads as
			// signed out rather than sending them looking for a fault.
			assert.strictEqual(kinds[KinguQuotaProvider.Claude], 'signedOut');
			assert.strictEqual(kinds[KinguQuotaProvider.Grok], 'signedOut');
			assert.strictEqual(kinds[KinguQuotaProvider.Kimi], 'error');
			assert.strictEqual(kinds[KinguQuotaProvider.Gemini], 'unavailable');
			assert.strictEqual(kinds[KinguQuotaProvider.Codex], 'loading');
		});

		test('a row that never reported is empty, not an error', () => {
			// A machine that never ran an agent's CLI is not in a fault state.
			const [row] = usageRows([source(KinguQuotaProvider.Kimi, [])]);
			assert.strictEqual(row.kind, 'empty');
			assert.ok(row.statusLabel);
		});

		test('windows are labelled by their length', () => {
			const [row] = usageRows([source(KinguQuotaProvider.Claude, [limit(10, 300), limit(70, 10_080)])]);
			assert.deepStrictEqual(row.windows.map(window => window.label), ['5h', 'wk']);
		});

		test('the row summarises itself by its fullest window', () => {
			const [row] = usageRows([source(KinguQuotaProvider.Claude, [limit(10, 300), limit(70, 10_080)])]);
			assert.strictEqual(row.worstPercent, 70);
			assert.strictEqual(tightestWindow(row)?.label, 'wk');
		});

		test('the soonest reset is the one the row counts down to', () => {
			const now = Date.now();
			const [row] = usageRows([source(KinguQuotaProvider.Claude, [
				limit(10, 300, now + 4 * 3_600_000),
				limit(70, 10_080, now + 48 * 3_600_000),
			])]);
			assert.ok(row.resetsInMs !== undefined && row.resetsInMs > 3.5 * 3_600_000 && row.resetsInMs <= 4 * 3_600_000);
		});

		test('a window with no reset does not invent one', () => {
			const [row] = usageRows([source(KinguQuotaProvider.Claude, [limit(10, 300)])]);
			assert.strictEqual(row.resetsInMs, undefined);
		});
	});

	suite('countdown', () => {

		test('coarse, because a five-hour window is not read to the second', () => {
			assert.strictEqual(formatResetCountdown(90_000), 'resets in 1m');
			assert.strictEqual(formatResetCountdown(45 * 60_000), 'resets in 45m');
			assert.strictEqual(formatResetCountdown(2 * 3_600_000), 'resets in 2h');
			assert.strictEqual(formatResetCountdown(2 * 3_600_000 + 33 * 60_000), 'resets in 2h 33m');
			assert.strictEqual(formatResetCountdown(50 * 3_600_000), 'resets in 2d 2h');
			assert.strictEqual(formatResetCountdown(48 * 3_600_000), 'resets in 2d');
		});

		test('a window already past does not count backwards', () => {
			assert.strictEqual(formatResetCountdown(-5_000), 'resets any moment');
			assert.strictEqual(formatResetCountdown(Number.NaN), 'resets any moment');
		});

		test('under a minute still reads as a minute rather than as zero', () => {
			// "resets in 0m" reads as "already reset", which it has not.
			assert.strictEqual(formatResetCountdown(20_000), 'resets in 1m');
		});
	});
});
