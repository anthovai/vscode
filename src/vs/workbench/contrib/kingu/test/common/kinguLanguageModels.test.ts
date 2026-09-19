/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import {
	KINGU_DEFAULT_ANTHROPIC_BASE_URL,
	parseKinguEndpointConfiguration,
	readEndpointError,
	readModelIds,
	readStreamedText,
	toAnthropicRequestBody,
	toOpenAIMessages,
} from '../../common/kinguLanguageModels.js';

function message(role: ChatMessageRole, text: string): IChatMessage {
	return { role, content: [{ type: 'text', value: text }] };
}

suite('Kingu language models', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseKinguEndpointConfiguration', () => {

		test('a group with no key contributes nothing', () => {
			assert.strictEqual(parseKinguEndpointConfiguration(undefined), undefined);
			assert.strictEqual(parseKinguEndpointConfiguration({}), undefined);
			assert.strictEqual(parseKinguEndpointConfiguration({ apiKey: '   ' }), undefined);
		});

		test('defaults to the Anthropic endpoint and dialect', () => {
			const endpoint = parseKinguEndpointConfiguration({ apiKey: 'k' });
			assert.strictEqual(endpoint?.baseUrl, KINGU_DEFAULT_ANTHROPIC_BASE_URL);
			assert.strictEqual(endpoint?.format, 'anthropic');
			assert.deepStrictEqual(endpoint?.modelIds, []);
		});

		test('strips trailing slashes so paths do not double up', () => {
			const endpoint = parseKinguEndpointConfiguration({ apiKey: 'k', baseUrl: 'http://localhost:11434//' });
			assert.strictEqual(endpoint?.baseUrl, 'http://localhost:11434');
		});

		test('reads pinned model ids, trimmed and deduplicated', () => {
			const endpoint = parseKinguEndpointConfiguration({ apiKey: 'k', models: ' a , b ,, a ' });
			assert.deepStrictEqual(endpoint?.modelIds, ['a', 'b']);
		});

		test('only a known dialect switches away from the default', () => {
			assert.strictEqual(parseKinguEndpointConfiguration({ apiKey: 'k', format: 'openai' })?.format, 'openai');
			assert.strictEqual(parseKinguEndpointConfiguration({ apiKey: 'k', format: 'nonsense' })?.format, 'anthropic');
		});
	});

	suite('toAnthropicRequestBody', () => {

		test('hoists system prompts out of the message list', () => {
			const body = toAnthropicRequestBody([
				message(ChatMessageRole.System, 'be brief'),
				message(ChatMessageRole.User, 'hello'),
			]);
			assert.strictEqual(body.system, 'be brief');
			assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hello' }]);
		});

		test('merges consecutive same-role turns, which the API rejects', () => {
			const body = toAnthropicRequestBody([
				message(ChatMessageRole.User, 'one'),
				message(ChatMessageRole.User, 'two'),
				message(ChatMessageRole.Assistant, 'ok'),
			]);
			assert.deepStrictEqual(body.messages, [
				{ role: 'user', content: 'one\ntwo' },
				{ role: 'assistant', content: 'ok' },
			]);
		});

		test('never leads with an assistant turn, which would read as a prefill', () => {
			const body = toAnthropicRequestBody([message(ChatMessageRole.Assistant, 'hi')]);
			assert.strictEqual(body.messages[0].role, 'user');
			assert.strictEqual(body.messages[1].role, 'assistant');
		});

		test('a system-only conversation still produces a valid message list', () => {
			const body = toAnthropicRequestBody([message(ChatMessageRole.System, 'rules')]);
			assert.strictEqual(body.system, 'rules');
			assert.deepStrictEqual(body.messages, [{ role: 'user', content: '' }]);
		});
	});

	test('toOpenAIMessages keeps system prompts inline', () => {
		assert.deepStrictEqual(toOpenAIMessages([
			message(ChatMessageRole.System, 'be brief'),
			message(ChatMessageRole.User, 'hello'),
		]), [
			{ role: 'system', content: 'be brief' },
			{ role: 'user', content: 'hello' },
		]);
	});

	suite('readStreamedText', () => {

		test('reads an Anthropic content delta', () => {
			const data = JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } });
			assert.strictEqual(readStreamedText('anthropic', data), 'hi');
		});

		test('ignores Anthropic frames that are not content deltas', () => {
			assert.strictEqual(readStreamedText('anthropic', JSON.stringify({ type: 'message_start' })), undefined);
			assert.strictEqual(readStreamedText('anthropic', JSON.stringify({ type: 'content_block_delta', delta: {} })), undefined);
		});

		test('reads an OpenAI choice delta', () => {
			const data = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] });
			assert.strictEqual(readStreamedText('openai', data), 'hi');
		});

		test('a keep-alive, terminator or truncated frame yields no text', () => {
			assert.strictEqual(readStreamedText('openai', '[DONE]'), undefined);
			assert.strictEqual(readStreamedText('openai', '{"choices":['), undefined);
			assert.strictEqual(readStreamedText('anthropic', ''), undefined);
		});
	});

	test('readModelIds tolerates a body that lists nothing', () => {
		assert.deepStrictEqual(readModelIds({ data: [{ id: 'a' }, { id: '' }, {}] }), ['a']);
		assert.deepStrictEqual(readModelIds({}), []);
		assert.deepStrictEqual(readModelIds('<html>'), []);
	});

	suite('readEndpointError', () => {

		test('prefers the endpoint\'s own message', () => {
			assert.strictEqual(readEndpointError(401, 'Unauthorized', JSON.stringify({ error: { message: 'bad key' } })), 'bad key');
			assert.strictEqual(readEndpointError(400, 'Bad Request', JSON.stringify({ message: 'nope' })), 'nope');
		});

		test('falls back to the status line rather than rendering a page', () => {
			assert.ok(readEndpointError(502, 'Bad Gateway', '<html>oh no</html>').includes('502'));
		});
	});
});
