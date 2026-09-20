/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KinguVaultSource } from '../../common/kinguVault.js';
import { addUsage, EMPTY_USAGE, formatTokens, readTranscriptUsage, totalTokens, uncachedTokens, usageModels } from '../../common/kinguVaultUsage.js';

const lines = (...records: object[]) => records.map(r => JSON.stringify(r)).join('\n');
const claudeTurn = (usage: object, model = 'claude-opus-5') => ({ message: { role: 'assistant', model, usage } });
const codexTotals = (totals: object) => ({ payload: { type: 'token_count', info: { total_token_usage: totals } } });

suite('Kingu vault usage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('Claude, which records what each message cost', () => {

		test('sums every message', () => {
			const usage = readTranscriptUsage(lines(
				claudeTurn({ input_tokens: 2, output_tokens: 97, cache_read_input_tokens: 34428, cache_creation_input_tokens: 16509 }),
				claudeTurn({ input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }),
			), KinguVaultSource.Claude);
			assert.strictEqual(usage.inputTokens, 7);
			assert.strictEqual(usage.outputTokens, 107);
			assert.strictEqual(usage.cacheReadTokens, 34528);
			assert.strictEqual(usage.cacheWriteTokens, 16509);
		});

		test('collects the models it ran against, without repeating them', () => {
			const usage = readTranscriptUsage(lines(
				claudeTurn({ output_tokens: 1 }, 'claude-opus-5'),
				claudeTurn({ output_tokens: 1 }, 'claude-sonnet-5'),
				claudeTurn({ output_tokens: 1 }, 'claude-opus-5'),
			), KinguVaultSource.Claude);
			assert.deepStrictEqual(usageModels(usage), ['claude-opus-5', 'claude-sonnet-5']);
			// And each model keeps its own share, which is what a price applies to.
			assert.deepStrictEqual(usage.byModel.map(entry => entry.outputTokens), [2, 1]);
		});

		test('ignores records that carry no usage', () => {
			const usage = readTranscriptUsage(lines({ type: 'summary' }, { message: { role: 'user', content: 'hi' } }), KinguVaultSource.Claude);
			assert.strictEqual(totalTokens(usage), 0);
		});

		test('treats a nonsensical count as zero rather than poisoning the total', () => {
			const usage = readTranscriptUsage(lines(claudeTurn({ input_tokens: -5, output_tokens: 'lots', cache_read_input_tokens: null })), KinguVaultSource.Claude);
			assert.strictEqual(totalTokens(usage), 0);
		});
	});

	suite('Codex, which records a running total', () => {

		test('takes the last total, not the sum of them', () => {
			// Summing these would report 60k for a session that spent 30k.
			const usage = readTranscriptUsage(lines(
				codexTotals({ input_tokens: 100, output_tokens: 50 }),
				codexTotals({ input_tokens: 400, output_tokens: 200 }),
			), KinguVaultSource.Codex);
			assert.strictEqual(usage.inputTokens, 400);
			assert.strictEqual(usage.outputTokens, 200);
		});

		test('counts a restarted counter as new spend, not as a negative delta', () => {
			// A resumed rollout writes a fresh baseline into the same file.
			const usage = readTranscriptUsage(lines(
				codexTotals({ input_tokens: 500 }),
				codexTotals({ input_tokens: 100 }),
				codexTotals({ input_tokens: 150 }),
			), KinguVaultSource.Codex);
			assert.strictEqual(usage.inputTokens, 650);
		});

		test('reads the cache fields under the names Codex uses', () => {
			const usage = readTranscriptUsage(lines(
				codexTotals({ cached_input_tokens: 900, cache_write_input_tokens: 300 }),
			), KinguVaultSource.Codex);
			assert.strictEqual(usage.cacheReadTokens, 900);
			assert.strictEqual(usage.cacheWriteTokens, 300);
		});

		test('a single total is the whole session', () => {
			const usage = readTranscriptUsage(lines(codexTotals({ input_tokens: 12681 })), KinguVaultSource.Codex);
			assert.strictEqual(usage.inputTokens, 12681);
		});

		test('reports nothing for a transcript with no token records', () => {
			assert.strictEqual(totalTokens(readTranscriptUsage(lines({ payload: { type: 'task_started' } }), KinguVaultSource.Codex)), 0);
		});
	});

	test('reading one family as the other is what these separate readers prevent', () => {
		// The same cumulative transcript read as per-message finds nothing, because
		// the counts are not where that reader looks.
		const cumulative = lines(codexTotals({ input_tokens: 400 }), codexTotals({ input_tokens: 800 }));
		assert.strictEqual(totalTokens(readTranscriptUsage(cumulative, KinguVaultSource.Claude)), 0);
		assert.strictEqual(readTranscriptUsage(cumulative, KinguVaultSource.Codex).inputTokens, 800);
	});

	suite('addUsage', () => {

		const model = (name: string, inputTokens: number) => ({ model: name, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

		test('adds the counts and merges each model into one entry', () => {
			const a = { ...EMPTY_USAGE, inputTokens: 10, byModel: [model('a', 10)] };
			const b = { ...EMPTY_USAGE, inputTokens: 5, outputTokens: 2, byModel: [model('a', 3), model('b', 2)] };
			const sum = addUsage(a, b);
			assert.strictEqual(sum.inputTokens, 15);
			assert.strictEqual(sum.outputTokens, 2);
			assert.deepStrictEqual(usageModels(sum), ['a', 'b']);
			// Merged rather than appended: two entries for one model would be priced
			// twice by anything that iterates them.
			assert.deepStrictEqual(sum.byModel.map(entry => entry.inputTokens), [13, 2]);
		});

		test('leaves its operands alone', () => {
			const a = { ...EMPTY_USAGE, byModel: [model('a', 1)] };
			addUsage(a, { ...EMPTY_USAGE, byModel: [model('a', 5), model('b', 1)] });
			assert.deepStrictEqual(a.byModel, [model('a', 1)]);
		});
	});

	test('formatTokens keeps a count readable at a glance', () => {
		assert.strictEqual(formatTokens(97), '97');
		assert.strictEqual(formatTokens(34428), '34.4k');
		assert.strictEqual(formatTokens(2_500_000), '2.5M');
		// A real vault reaches billions; `26330.2M` is not a number anyone reads.
		assert.strictEqual(formatTokens(26_330_200_000), '26.3B');
		assert.strictEqual(formatTokens(0), '0');
	});

	test('uncachedTokens leaves out the cache, which is most of the total', () => {
		// Measured on a real session: 259M cached against 613k of output, so a
		// headline including the cache says nothing about the work.
		const usage = { ...EMPTY_USAGE, inputTokens: 1_453, outputTokens: 612_934, cacheReadTokens: 259_397_598, cacheWriteTokens: 6_200_650 };
		assert.strictEqual(uncachedTokens(usage), 614_387);
		assert.strictEqual(totalTokens(usage), 266_212_635);
	});
});
