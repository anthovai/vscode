/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { cleanChyleText, IChyleOfferedTool, recoverChyleToolCalls } from '../../common/chyleToolText.js';

suite('chyleToolText', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const tools: IChyleOfferedTool[] = [
		{ name: 'write', parameters: { properties: { path: { type: 'string' }, content: { type: 'string' } } } },
		{ name: 'read', parameters: { properties: { path: { type: 'string' }, limit: { type: 'integer' } } } },
	];

	test('recovers Qwen XML calls, typing values by the schema and keeping the prose', () => {
		const text = 'I will write it.\n<tool_call>\n<function=write>\n<parameter=path>\na.js\n</parameter>\n<parameter=content>\nconst x = 1;\n</parameter>\n</function>\n</tool_call>\n<function=read><parameter=path>b.js</parameter><parameter=limit>20</parameter></function>';
		assert.deepStrictEqual(recoverChyleToolCalls(text, tools), {
			text: 'I will write it.',
			calls: [
				{ name: 'write', arguments: JSON.stringify({ path: 'a.js', content: 'const x = 1;' }) },
				{ name: 'read', arguments: JSON.stringify({ path: 'b.js', limit: 20 }) },
			],
		});
	});

	test('recovers JSON calls, plain or in the function shape, and ignores tools that were not offered', () => {
		const text = 'Reading.\n```json\n{"name": "read", "arguments": {"path": "a.js"}}\n```\n{"function": {"name": "write", "arguments": "{\\"path\\":\\"b.js\\"}"}} {"name": "delete", "arguments": {"path": "c.js"}}';
		assert.deepStrictEqual(recoverChyleToolCalls(text, tools), {
			text: 'Reading.\n\n {"name": "delete", "arguments": {"path": "c.js"}}',
			calls: [
				{ name: 'read', arguments: JSON.stringify({ path: 'a.js' }) },
				{ name: 'write', arguments: '{"path":"b.js"}' },
			],
		});
	});

	test('leaves prose alone and drops stray wrappers', () => {
		assert.deepStrictEqual({
			prose: recoverChyleToolCalls('I am Arkai. {not json}', tools),
			noTools: recoverChyleToolCalls('<function=write><parameter=path>a</parameter></function>', []),
			cleaned: cleanChyleText('I am Arkai.\n<tool_call>\n'),
		}, {
			prose: undefined,
			noTools: undefined,
			cleaned: 'I am Arkai.',
		});
	});
});
