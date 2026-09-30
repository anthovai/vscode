/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { kinguSmartSearchPattern, kinguSmartSearchQueryText, smartSearchWords } from '../../common/kinguSmartSearch.js';

suite('kinguSmartSearch', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const finds = (query: string, text: string) => {
		const pattern = kinguSmartSearchPattern(query);
		return pattern === undefined ? text.includes(query) : new RegExp(pattern, 'i').test(text);
	};

	test('splits names where they are joined', () => {
		assert.deepStrictEqual([smartSearchWords('stockLedger'), smartSearchWords('stock_ledger check'), smartSearchWords('HTTPServer'), smartSearchWords('  ')], [
			['stock', 'Ledger'], ['stock', 'ledger', 'check'], ['HTTP', 'Server'], [],
		]);
	});

	test('finds a name however it is written, the words in any order, and leaves a single word as typed', () => {
		assert.deepStrictEqual({
			camel: finds('stock ledger', 'const stockLedger = 1'),
			snake: finds('stock ledger', 'stock_ledgers table'),
			kebab: finds('StockLedger', '<stock-ledger>'),
			reordered: finds('ledger stock', 'the stock ledger'),
			apart: finds('ledger check', 'php artisan inventory:ledger-check'),
			absent: finds('stock ledger', 'stock only'),
			single: kinguSmartSearchPattern('ledger'),
			special: finds('a.b c', 'a.b and c'),
		}, {
			camel: true, snake: true, kebab: true, reordered: true, apart: true, absent: false, single: undefined, special: true,
		});
	});

	test('gives back the words a smart pattern was made from, and other text as is', () => {
		assert.deepStrictEqual([
			kinguSmartSearchQueryText(kinguSmartSearchPattern('stock movement')!),
			kinguSmartSearchQueryText(kinguSmartSearchPattern('a.b c')!),
			kinguSmartSearchQueryText('ตรวจสอบสต็อก'),
		], ['stock movement', 'a b c', 'ตรวจสอบสต็อก']);
	});
});
