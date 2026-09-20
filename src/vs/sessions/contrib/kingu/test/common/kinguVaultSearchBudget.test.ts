/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	groupSearchByHost,
	KinguSearchLedger,
	LOCAL_SEARCH_BUDGET,
	REMOTE_SEARCH_BUDGET,
	searchBudgetFor,
} from '../../common/kinguVaultSearchBudget.js';

suite('Kingu vault search budget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a remote read is smaller and less parallel than a local one, in every dimension', () => {
		assert.ok(REMOTE_SEARCH_BUDGET.perSessionBytes < LOCAL_SEARCH_BUDGET.perSessionBytes);
		assert.ok(REMOTE_SEARCH_BUDGET.totalBytes < LOCAL_SEARCH_BUDGET.totalBytes);
		assert.ok(REMOTE_SEARCH_BUDGET.concurrency < LOCAL_SEARCH_BUDGET.concurrency);
	});

	test('the local budget has no total, so a local search is never silently partial', () => {
		assert.strictEqual(LOCAL_SEARCH_BUDGET.totalBytes, Number.POSITIVE_INFINITY);
		assert.strictEqual(new KinguSearchLedger(LOCAL_SEARCH_BUDGET).exhausted, false);
	});

	test('picks the budget from whether the machine is this one', () => {
		assert.strictEqual(searchBudgetFor(false), LOCAL_SEARCH_BUDGET);
		assert.strictEqual(searchBudgetFor(true), REMOTE_SEARCH_BUDGET);
	});

	suite('the ledger', () => {

		const budget = { perSessionBytes: 100, totalBytes: 250, concurrency: 2 };

		test('hands out one session at a time until the total is gone', () => {
			const ledger = new KinguSearchLedger(budget);
			assert.strictEqual(ledger.claim(), 100);
			assert.strictEqual(ledger.claim(), 100);
			// The last claim is what is left, not a full allowance.
			assert.strictEqual(ledger.claim(), 50);
			assert.strictEqual(ledger.claim(), 0);
			assert.strictEqual(ledger.exhausted, true);
		});

		test('claims up front, so workers in flight cannot overspend between them', () => {
			const ledger = new KinguSearchLedger(budget);
			// Two workers claim before either has read a byte.
			ledger.claim();
			ledger.claim();
			assert.strictEqual(ledger.spent, 200);
		});

		test('a short transcript gives back what it did not use', () => {
			const ledger = new KinguSearchLedger(budget);
			const claimed = ledger.claim();
			ledger.refund(claimed, 10);
			assert.strictEqual(ledger.spent, 10);
		});

		test('a read that used its whole allowance gives nothing back', () => {
			const ledger = new KinguSearchLedger(budget);
			ledger.refund(ledger.claim(), 100);
			assert.strictEqual(ledger.spent, 100);
		});
	});

	suite('grouping', () => {

		test('this machine comes first, so a capped search answers from it', () => {
			const groups = [...groupSearchByHost([{ hostLabel: 'build-box' }, {}])];
			assert.strictEqual(groups[0][0], undefined);
		});

		test('this machine is a group even when every session is elsewhere', () => {
			// Present and empty rather than absent: the walk iterates the groups, and
			// an absent local group would be a different code path for no reason.
			const groups = groupSearchByHost([{ hostLabel: 'build-box' }]);
			assert.deepStrictEqual(groups.get(undefined), []);
		});

		test('each machine keeps its own sessions, in the order they arrived', () => {
			const groups = groupSearchByHost([
				{ hostLabel: 'a', id: 1 },
				{ hostLabel: 'b', id: 2 },
				{ hostLabel: 'a', id: 3 },
			] as { hostLabel?: string; id: number }[]);
			assert.deepStrictEqual(groups.get('a')?.map(item => item.id), [1, 3]);
			assert.deepStrictEqual(groups.get('b')?.map(item => item.id), [2]);
		});
	});
});
