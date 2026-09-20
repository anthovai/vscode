/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KinguVaultSource } from '../../common/kinguVault.js';
import { IKinguUsage } from '../../common/kinguVaultUsage.js';
import {
	buildKinguUsageOverview,
	formatShare,
	IKinguOverviewSession,
	localDayKey,
	sessionCostUsd,
} from '../../common/kinguUsageOverview.js';

const DAY = 86_400_000;

function usage(counts: Partial<IKinguUsage> & { byModel?: IKinguUsage['byModel'] } = {}): IKinguUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		byModel: [],
		...counts,
	};
}

/** A session whose one model is priced, so the roll-up has a dollar figure to work with. */
function claudeSession(modified: number, counts: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): IKinguOverviewSession {
	const tokens = {
		inputTokens: counts.input,
		outputTokens: counts.output,
		cacheReadTokens: counts.cacheRead ?? 0,
		cacheWriteTokens: counts.cacheWrite ?? 0,
	};
	return {
		source: KinguVaultSource.Claude,
		sourceLabel: 'Claude',
		modified,
		usage: usage({ ...tokens, byModel: [{ model: 'claude-sonnet-4-5-20250929', ...tokens }] }),
	};
}

suite('Kingu usage overview', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const now = new Date(2026, 8, 20, 15, 0, 0).getTime();

	suite('cost', () => {

		test('a session is priced per model, not once for the session', () => {
			// A plan on the large model and the edits on the small one cost
			// different amounts for the same token count.
			const split = sessionCostUsd(usage({
				byModel: [
					{ model: 'claude-opus-4-1-20250805', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
					{ model: 'claude-haiku-4-5-20251001', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				],
			}));
			const opusOnly = sessionCostUsd(usage({
				byModel: [{ model: 'claude-opus-4-1-20250805', inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }],
			}));
			assert.ok(split !== undefined && opusOnly !== undefined);
			assert.ok(split < opusOnly, `${split} should be cheaper than ${opusOnly}`);
		});

		test('a model no table prices leaves the cost unknown, not zero', () => {
			// Zero is a claim that it was free.
			assert.strictEqual(sessionCostUsd(usage({
				byModel: [{ model: 'some-unreleased-model', inputTokens: 5_000, outputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0 }],
			})), undefined);
		});
	});

	suite('totals', () => {

		test('an unpriced session beside a priced one makes the total a floor', () => {
			const overview = buildKinguUsageOverview([
				claudeSession(now, { input: 10_000, output: 2_000 }),
				{
					source: KinguVaultSource.Claude,
					sourceLabel: 'Claude',
					modified: now,
					usage: usage({ inputTokens: 900, outputTokens: 100, byModel: [{ model: 'mystery', inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }] }),
				},
			], { days: 7, now });
			assert.ok(overview.costUsd !== undefined && overview.costUsd > 0);
			assert.strictEqual(overview.partialCost, true);
		});

		test('a session that ran nothing does not make an exact total look partial', () => {
			const overview = buildKinguUsageOverview([
				claudeSession(now, { input: 10_000, output: 2_000 }),
				{ source: KinguVaultSource.Claude, sourceLabel: 'Claude', modified: now, usage: usage() },
			], { days: 7, now });
			assert.strictEqual(overview.partialCost, false);
		});

		test('nothing priced at all leaves the cost unknown', () => {
			const overview = buildKinguUsageOverview([
				{ source: KinguVaultSource.Cursor, sourceLabel: 'Cursor', modified: now, usage: usage({ inputTokens: 10, outputTokens: 10 }) },
			], { days: 7, now });
			assert.strictEqual(overview.costUsd, undefined);
			assert.strictEqual(overview.partialCost, false);
		});
	});

	suite('the token mix', () => {

		test('Claude reports cache reads beside the input', () => {
			const overview = buildKinguUsageOverview([
				claudeSession(now, { input: 1_000, output: 500, cacheRead: 9_000 }),
			], { days: 7, now });
			assert.strictEqual(overview.newInputTokens, 1_000);
			assert.strictEqual(overview.cacheTokens, 9_000);
		});

		test('Codex reports them inside it, so they come back out', () => {
			// Codex reports the cached part inside `input_tokens`; counting it as
			// fresh would overstate what was actually sent by an order of magnitude.
			const overview = buildKinguUsageOverview([{
				source: KinguVaultSource.Codex,
				sourceLabel: 'Codex',
				modified: now,
				usage: usage({ inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 9_000 }),
			}], { days: 7, now });
			assert.strictEqual(overview.newInputTokens, 1_000);
			assert.strictEqual(overview.cacheTokens, 9_000);
		});

		test('a transcript reporting more cache than input does not go negative', () => {
			const overview = buildKinguUsageOverview([{
				source: KinguVaultSource.Codex,
				sourceLabel: 'Codex',
				modified: now,
				usage: usage({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 900 }),
			}], { days: 7, now });
			assert.strictEqual(overview.newInputTokens, 0);
		});

		test('the cache share is of what was sent, and unknown when nothing was', () => {
			const busy = buildKinguUsageOverview([claudeSession(now, { input: 1_000, output: 500, cacheRead: 3_000 })], { days: 7, now });
			assert.strictEqual(formatShare(busy.cacheShare), '75%');
			assert.strictEqual(formatShare(buildKinguUsageOverview([], { days: 7, now }).cacheShare), 'n/a');
		});

		test('a share does not round into a claim it cannot make', () => {
			// Real vaults sit here: cache reads are 99.99% of everything sent, and
			// `100%` would say nothing was ever sent fresh while the fresh tokens
			// themselves printed `0%`.
			assert.strictEqual(formatShare(0.9999), '>99%');
			assert.strictEqual(formatShare(0.0001), '<1%');
			// The ends stay exact, because those claims are true.
			assert.strictEqual(formatShare(1), '100%');
			assert.strictEqual(formatShare(0), '0%');
		});
	});

	suite('providers', () => {

		test('the busiest agent is first', () => {
			const overview = buildKinguUsageOverview([
				{ source: KinguVaultSource.Cursor, sourceLabel: 'Cursor', modified: now, usage: usage({ inputTokens: 10, outputTokens: 0 }) },
				claudeSession(now, { input: 100_000, output: 10_000 }),
			], { days: 7, now });
			assert.deepStrictEqual(overview.providers.map(provider => provider.source), [KinguVaultSource.Claude, KinguVaultSource.Cursor]);
		});

		test('each agent carries its own last activity, and the page the latest of them', () => {
			const overview = buildKinguUsageOverview([
				claudeSession(now - 5 * DAY, { input: 10, output: 10 }),
				claudeSession(now - DAY, { input: 10, output: 10 }),
				{ source: KinguVaultSource.Cursor, sourceLabel: 'Cursor', modified: now - 9 * DAY, usage: usage({ inputTokens: 1, outputTokens: 1 }) },
			], { days: 30, now });
			const claude = overview.providers.find(provider => provider.source === KinguVaultSource.Claude);
			assert.strictEqual(claude?.lastActivityAt, now - DAY);
			assert.strictEqual(claude?.sessions, 2);
			assert.strictEqual(overview.lastActivityAt, now - DAY);
		});
	});

	suite('the daily series', () => {

		test('every day in the window is present, including the quiet ones', () => {
			// A grid with the empty days missing would compress a fortnight off
			// and read as continuous work.
			const overview = buildKinguUsageOverview([claudeSession(now, { input: 10, output: 10 })], { days: 14, now });
			assert.strictEqual(overview.daily.length, 14);
			assert.strictEqual(overview.daily.at(-1)?.day, localDayKey(now));
			assert.strictEqual(overview.daily[0].totalTokens, 0);
		});

		test('sessions older than the window still count towards the totals', () => {
			// "What have my agents cost" is not a question about the last fortnight.
			const overview = buildKinguUsageOverview([claudeSession(now - 100 * DAY, { input: 5_000, output: 1_000 })], { days: 14, now });
			assert.strictEqual(overview.sessions, 1);
			assert.strictEqual(overview.totalTokens, 6_000);
			assert.strictEqual(overview.activeDays, 0);
			assert.strictEqual(overview.bestDay, undefined);
		});

		test('sessions on the same day are one day', () => {
			const overview = buildKinguUsageOverview([
				claudeSession(now, { input: 1_000, output: 0 }),
				claudeSession(now - 3_600_000, { input: 2_000, output: 0 }),
				claudeSession(now - 2 * DAY, { input: 500, output: 0 }),
			], { days: 14, now });
			assert.strictEqual(overview.activeDays, 2);
			assert.strictEqual(overview.bestDay?.day, localDayKey(now));
			assert.strictEqual(overview.bestDay?.totalTokens, 3_000);
		});

		test('a window with no work at all has no best day', () => {
			const overview = buildKinguUsageOverview([], { days: 14, now });
			assert.strictEqual(overview.bestDay, undefined);
			assert.strictEqual(overview.activeDays, 0);
			assert.strictEqual(overview.daily.length, 14);
		});
	});
});
