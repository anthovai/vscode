/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IByokLmChatResult, IByokLmModelInfo } from '../../../common/agentHostByokLm.js';
import { pickUtilityModel, readByokText, toByokInput } from '../../../common/kingu/byokUtilityChat.js';

function model(id: string, name?: string): IByokLmModelInfo {
	return { vendor: 'kingu', id, name, identifier: `kingu/${id}` } as IByokLmModelInfo;
}

suite('Kingu BYOK utility chat', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('which model a utility call asks', () => {

		test('the small tier, because the user is paying for a sentence they did not ask for', () => {
			const picked = pickUtilityModel([model('claude-opus-5'), model('claude-haiku-4-5')]);
			assert.strictEqual(picked?.id, 'claude-haiku-4-5');
		});

		test('recognises the small tier under each provider name for it', () => {
			for (const id of ['gpt-5-mini', 'gpt-5-nano', 'gemini-flash', 'some-small-model', 'a-lite', 'x-turbo']) {
				assert.strictEqual(pickUtilityModel([model('big-expensive'), model(id)])?.id, id, id);
			}
		});

		test('reads the display name too, since an id is not always the readable one', () => {
			assert.strictEqual(pickUtilityModel([model('m-1'), model('m-2', 'Haiku 4.5')])?.id, 'm-2');
		});

		test('falls back to the first model rather than refusing', () => {
			// Being wrong costs a slightly more expensive call, not a wrong answer.
			assert.strictEqual(pickUtilityModel([model('only-big')])?.id, 'only-big');
		});

		test('no models is no model, which the caller reports as itself', () => {
			assert.strictEqual(pickUtilityModel([]), undefined);
		});
	});

	suite('reading what came back', () => {

		const result = (output: IByokLmChatResult['output'], error?: string): IByokLmChatResult => ({ output, error });

		test('joins the message parts and leaves the rest alone', () => {
			const text = readByokText(result([
				{ type: 'reasoning', id: 'r', summary: [] },
				{ type: 'message', content: [{ type: 'text', text: 'Fix the ' }, { type: 'text', text: 'rounding' }] },
			] as IByokLmChatResult['output']));
			assert.strictEqual(text, 'Fix the rounding');
		});

		test('an error is not an answer, whatever else came with it', () => {
			const text = readByokText(result(
				[{ type: 'message', content: [{ type: 'text', text: 'partial' }] }] as IByokLmChatResult['output'],
				'rate limited'));
			assert.strictEqual(text, undefined);
		});

		test('an empty reply is no answer, not an empty title', () => {
			assert.strictEqual(readByokText(result([])), undefined);
			assert.strictEqual(readByokText(result([{ type: 'message', content: [{ type: 'text', text: '   ' }] }] as IByokLmChatResult['output'])), undefined);
		});
	});

	test('the prompt goes over the wire as one user message', () => {
		const input = toByokInput({ instructions: 'be brief', prompt: 'Branch: fix-rounding' });
		assert.deepStrictEqual(input, [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Branch: fix-rounding' }] }]);
	});
});
