/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildFimPrompt, cleanCompletion, isMidLine } from '../../common/kinguCompletions.js';
import { kinguLocalChatModels } from '../../common/kinguLocalModels.js';

suite('kinguCompletions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('asks for the middle, the code nearest the cursor kept', () => {
		assert.strictEqual(buildFimPrompt('def add(a, b):\n    ', '\nprint(add(1, 2))'), '<|fim_prefix|>def add(a, b):\n    <|fim_suffix|>\nprint(add(1, 2))<|fim_middle|>');
		assert.ok(buildFimPrompt('x'.repeat(5000), '').startsWith('<|fim_prefix|>' + 'x'.repeat(4000) + '<|fim_suffix|>'));
	});

	test('cleans what the model gives back', () => {
		assert.deepStrictEqual([
			cleanCompletion('return a + b\n<|endoftext|>junk', '\n'),
			cleanCompletion('  \n', ''),
			cleanCompletion('foo(bar)', ')'),
			cleanCompletion('value; ', ''),
			cleanCompletion('a + b;  // return a + b;  // return a + b;  // ret', '\n}'),
			cleanCompletion('items.map(item => item.id)', ''),
		], ['return a + b', undefined, 'foo(bar', 'value; ', 'a + b;', 'items.map(item => item.id)']);
		assert.deepStrictEqual([isMidLine('function f() {\n\treturn '), isMidLine('function f() {\n\t')], [true, false]);
	});

	test('offers Chyle first, then coding models, and never embedders', () => {
		assert.deepStrictEqual(kinguLocalChatModels(['bge-m3:latest', 'llama3:8b', 'qwen2.5-coder:7b', 'chyle-1-coder:latest', 'nomic-embed-text:latest', 'scb10x/typhoon-ocr-3b:latest']), [
			'chyle-1-coder:latest', 'qwen2.5-coder:7b', 'llama3:8b',
		]);
	});
});
