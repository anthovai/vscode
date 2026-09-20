/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { estimateCostUsd, formatCostUsd, normalizeCodexModelForPricing, normalizeModelForPricing } from '../../common/kinguPricing.js';

const NOTHING = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

suite('Kingu pricing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('which model a transcript meant', () => {

		test('reads the family out of the id the CLI actually wrote', () => {
			for (const [id, family] of [
				['claude-opus-5', 'claude-opus-5'],
				['claude-opus-5-20260101', 'claude-opus-5'],
				['anthropic/claude-opus-5', 'claude-opus-5'],
				['claude-sonnet-4.5', 'claude-sonnet-4-5'],
				['claude-opus-4-6-thinking', 'claude-opus-4-6'],
				['claude-haiku-4-5', 'claude-haiku-4-5'],
			]) {
				assert.strictEqual(normalizeModelForPricing(id), family, id);
			}
		});

		test('a version-first id from an older transcript still resolves', () => {
			assert.strictEqual(normalizeModelForPricing('claude-3-5-sonnet-20241022'), 'claude-sonnet-3-5');
			assert.strictEqual(normalizeModelForPricing('claude-3-5-haiku-20241022'), 'claude-haiku-3-5');
		});

		test('a point release is not swallowed by a shorter family', () => {
			// `opus-4-1` must not match inside `opus-4-12`, which is a different model.
			assert.strictEqual(normalizeModelForPricing('claude-opus-4-12'), 'claude-opus-4');
		});

		test('a model the Claude list does not know resolves to nothing', () => {
			assert.strictEqual(normalizeModelForPricing('gpt-5-codex'), undefined);
			assert.strictEqual(normalizeModelForPricing('gemini-3-pro'), undefined);
			assert.strictEqual(normalizeModelForPricing(undefined), undefined);
			assert.strictEqual(normalizeModelForPricing(''), undefined);
		});
	});

	suite('what it cost', () => {

		test('prices each kind of token at its own rate', () => {
			// Opus 5: $5 in, $25 out, $0.50 cache read, $6.25 cache write per million.
			const cost = estimateCostUsd('claude-opus-5', {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				cacheReadTokens: 1_000_000,
				cacheWriteTokens: 1_000_000,
			});
			assert.strictEqual(cost, 5 + 25 + 0.5 + 6.25);
		});

		test('a cache read is a fraction of fresh input, which is the whole point of the split', () => {
			const read = estimateCostUsd('claude-opus-5', { ...NOTHING, cacheReadTokens: 1_000_000 })!;
			const input = estimateCostUsd('claude-opus-5', { ...NOTHING, inputTokens: 1_000_000 })!;
			assert.ok(read * 5 < input, `${read} should be far below ${input}`);
		});

		test('the older Sonnets bill above 200k at their long-context rate', () => {
			const cost = estimateCostUsd('claude-sonnet-4-5', { ...NOTHING, inputTokens: 300_000 })!;
			// 200k at $3 and 100k at $6.
			assert.ok(Math.abs(cost - (0.2 * 3 + 0.1 * 6)) < 1e-9, String(cost));
		});

		test('a model with no long-context tier bills its whole window at one rate', () => {
			const cost = estimateCostUsd('claude-sonnet-5', { ...NOTHING, inputTokens: 1_000_000 })!;
			assert.strictEqual(cost, 2);
		});

		test('an unpriced model reports nothing rather than zero', () => {
			// A zero would read as "this was free", which is the one wrong answer
			// that looks like an answer.
			assert.strictEqual(estimateCostUsd('gemini-3-pro', { ...NOTHING, inputTokens: 1_000_000 }), undefined);
			assert.strictEqual(estimateCostUsd('<synthetic>', { ...NOTHING, inputTokens: 1_000_000 }), undefined);
		});
	});

	suite('Codex, whose prices are shaped differently', () => {

		test('reads the family, ignoring the reasoning tier which does not change the price', () => {
			assert.strictEqual(normalizeCodexModelForPricing('gpt-5.6-terra'), 'gpt-5-6-terra');
			assert.strictEqual(normalizeCodexModelForPricing('gpt-5.6-terra-high'), 'gpt-5-6-terra');
			assert.strictEqual(normalizeCodexModelForPricing('gpt-5.5 (medium)'), 'gpt-5-5');
			assert.strictEqual(normalizeCodexModelForPricing('gpt-5-codex'), 'gpt-5');
		});

		test('the bare 5.6 alias routes to Sol, and does not swallow the named tiers', () => {
			assert.strictEqual(normalizeCodexModelForPricing('gpt-5.6'), 'gpt-5-6-sol');
			assert.strictEqual(normalizeCodexModelForPricing('gpt-5.6-luna'), 'gpt-5-6-luna');
		});

		test('a longer family wins over a shorter one it starts with', () => {
			// `gpt-5.5-pro` must not be priced as `gpt-5.5`; they differ six-fold.
			assert.strictEqual(normalizeCodexModelForPricing('gpt-5.5-pro'), 'gpt-5-5-pro');
		});

		test('cached tokens are inside the input count, so they are not billed twice', () => {
			// 200k input of which 150k cached, all below the long-context threshold,
			// at $2.50 uncached and $0.25 cached per million.
			const cost = estimateCostUsd('gpt-5.6-terra', {
				inputTokens: 200_000,
				outputTokens: 0,
				cacheReadTokens: 150_000,
				cacheWriteTokens: 0,
			})!;
			assert.ok(Math.abs(cost - (0.05 * 2.5 + 0.15 * 0.25)) < 1e-9, String(cost));
			// Charging the full input rate on all 200k as well would cost this much.
			assert.ok(cost < (0.2 * 2.5 + 0.15 * 0.25));
		});

		test('each bucket crosses the long-context tier on its own size', () => {
			// 1M input of which 800k cached: the cached bucket alone is past 272k, so
			// most of it bills at the higher cached rate while the 200k of uncached
			// input stays under. Checked because the arithmetic is not obvious and a
			// per-total threshold would give a different, wrong answer.
			const cost = estimateCostUsd('gpt-5.6-terra', {
				inputTokens: 1_000_000,
				outputTokens: 0,
				cacheReadTokens: 800_000,
				cacheWriteTokens: 0,
			})!;
			const expected = (200_000 * 2.5 + 272_000 * 0.25 + 528_000 * 0.5) / 1_000_000;
			assert.ok(Math.abs(cost - expected) < 1e-9, `${cost} vs ${expected}`);
		});

		test('more cache than input cannot produce a negative charge', () => {
			const cost = estimateCostUsd('gpt-5.6-terra', {
				inputTokens: 1_000,
				outputTokens: 0,
				cacheReadTokens: 9_000,
				cacheWriteTokens: 0,
			})!;
			assert.ok(cost > 0, String(cost));
		});

		test('an OpenAI model the list does not know reports nothing', () => {
			assert.strictEqual(estimateCostUsd('gpt-9', { ...NOTHING, inputTokens: 1_000_000 }), undefined);
		});
	});

	suite('how a cost reads', () => {

		test('two decimals, because that is what money has', () => {
			assert.strictEqual(formatCostUsd(12.4), '$12.40');
			assert.strictEqual(formatCostUsd(0.03), '$0.03');
		});

		test('a spend too small to round to a cent is not called zero', () => {
			assert.strictEqual(formatCostUsd(0.004), '<$0.01');
		});

		test('nothing spent is nothing', () => {
			assert.strictEqual(formatCostUsd(0), '$0.00');
		});
	});
});
