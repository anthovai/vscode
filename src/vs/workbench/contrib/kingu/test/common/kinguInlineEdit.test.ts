/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { kinguInlineEditCode, kinguInlineEditPrompt } from '../../common/kinguInlineEdit.js';

suite('kinguInlineEdit', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks the lines to rewrite inside the file', () => {
		const prompt = kinguInlineEditPrompt({
			languageId: 'typescript',
			lines: ['function add(a, b) {', '\treturn ', '}'],
			startLineNumber: 2,
			endLineNumber: 2,
			instruction: 'return the sum',
		});
		assert.strictEqual(prompt.user, 'Language: typescript\n\nfunction add(a, b) {\n<edit>\n\treturn \n</edit>\n}\n\nInstruction: return the sum');
	});

	test('keeps only the code of the answer', () => {
		assert.deepStrictEqual([
			kinguInlineEditCode('\treturn a + b;\n'),
			kinguInlineEditCode('Here you go:\n```ts\n\treturn a + b;\n```\nDone.'),
			kinguInlineEditCode('<think>easy</think>\n<edit>\n\treturn a + b;\n</edit>'),
			kinguInlineEditCode('  \n'),
		], ['\treturn a + b;', '\treturn a + b;', '\treturn a + b;', undefined]);
	});

	test('leaves out the lines around the region the model copied along', () => {
		const region = { languageId: 'typescript', lines: ['// sum', 'function add(a, b) {', '\t// TODO', '}', ''], startLineNumber: 3, endLineNumber: 3, instruction: 'implement' };
		assert.deepStrictEqual([
			kinguInlineEditCode('function add(a, b) {\n\treturn a + b;\n}', region),
			kinguInlineEditCode('\treturn a + b;', region),
		], ['\treturn a + b;', '\treturn a + b;']);
	});
});
