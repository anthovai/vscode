/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { bestLine, chunkText, dot, normalize, pickEmbeddingModel } from '../../common/kinguSemanticSearch.js';

suite('kinguSemanticSearch', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('chunks in overlapping windows and leaves blank ones out', () => {
		const text = Array.from({ length: 115 }, (_, i) => `line ${i}`).join('\n');
		assert.deepStrictEqual(chunkText(text).map(chunk => [chunk.startLine, chunk.lines.length]), [[0, 60], [50, 60], [100, 15]]);
		assert.deepStrictEqual(chunkText('\n\n  \n'), []);
	});

	test('shows the line that shares most words with the query', () => {
		const chunk = { startLine: 10, lines: ['', 'class Foo {}', 'function stockLedger() {}', 'stock ledger check'] };
		assert.deepStrictEqual(bestLine(chunk, 'ledger check'), { line: 13, text: 'stock ledger check' });
		assert.deepStrictEqual(bestLine({ startLine: 0, lines: ['<?php', 'namespace App;', '', 'class InventoryLedgerCheck'] }, 'ตรวจสอบ'), { line: 3, text: 'class InventoryLedgerCheck' });
	});

	test('ranks by cosine and picks the embedding model', () => {
		assert.strictEqual(Math.round(dot(normalize([1, 0]), normalize([1, 1])) * 100) / 100, 0.71);
		assert.deepStrictEqual([
			pickEmbeddingModel(['chyle-1-coder:latest', 'nomic-embed-text:latest', 'bge-m3:latest']),
			pickEmbeddingModel(['qwen3:8b', 'my-embed-model']),
			pickEmbeddingModel(['qwen3:8b']),
		], ['bge-m3:latest', 'my-embed-model', undefined]);
	});
});
