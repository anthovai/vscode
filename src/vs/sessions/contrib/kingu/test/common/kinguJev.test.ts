/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { JEV_MAX_STATE_CHARS, jevProblemForStatus, jevRequestBody, parseJevResponse, resolveJevEndpoint } from '../../../../../platform/kinguHost/common/kinguJev.js';
import { AGENT_STATUS_QUESTION, agentStatusFromAnswer, isAgentTerminalName, isFocusReport, KinguAgentTerminalStatus, plainTerminalText, TerminalOutputTail } from '../../common/kinguJevTerminal.js';

suite('Kingu Jev', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds the systemone body, the state kept to its latest part', () => {
		const long = 'x'.repeat(JEV_MAX_STATE_CHARS) + 'LATEST';
		const body = JSON.parse(jevRequestBody({ state: long, questions: { status: AGENT_STATUS_QUESTION } }));
		assert.deepStrictEqual([body.model, body.state.length, body.state.endsWith('LATEST'), Object.keys(body.questions.status.criteria)], [
			'jev-latest', JEV_MAX_STATE_CHARS, true, ['working', 'needs_input', 'done', 'error'],
		]);
	});

	test('reads the answers it trusts and drops the rest', () => {
		assert.deepStrictEqual(parseJevResponse({
			model: 'jev-1.13.0',
			answers: {
				status: { type: 'choice', choice: 'needs_input', confidence: 0.91, probabilities: { needs_input: 0.91, working: 0.09 } },
				urgent: { type: 'noul', probability: 0.2, confidence: 0.8 },
				broken: { type: 'choice', choice: 7 },
			},
			usage: { input_tokens: 312, output_tokens: 0 },
		}), {
			ok: true,
			model: 'jev-1.13.0',
			answers: {
				status: { type: 'choice', choice: 'needs_input', confidence: 0.91, probabilities: { needs_input: 0.91, working: 0.09 } },
				urgent: { type: 'noul', probability: 0.2, confidence: 0.8 },
			},
		});
		assert.deepStrictEqual([parseJevResponse(null), parseJevResponse({ answers: {} })], [{ ok: false, problem: 'invalid' }, { ok: false, problem: 'invalid' }]);
	});

	test('sends a key only somewhere safe', () => {
		assert.deepStrictEqual([
			resolveJevEndpoint(undefined),
			resolveJevEndpoint('https://gateway.example.com/typesafe/v1/systemone'),
			resolveJevEndpoint('http://127.0.0.1:4000/typesafe/v1/systemone'),
			resolveJevEndpoint('http://gateway.example.com/v1/systemone'),
			resolveJevEndpoint('https://user:pass@gateway.example.com/'),
			resolveJevEndpoint('not a url'),
		], [
			'https://api.typesafe.ai/v1/systemone',
			'https://gateway.example.com/typesafe/v1/systemone',
			'http://127.0.0.1:4000/typesafe/v1/systemone',
			undefined, undefined, undefined,
		]);
	});

	test('names what an HTTP failure means', () => {
		assert.deepStrictEqual([401, 403, 429, 500, 503, 400].map(jevProblemForStatus), ['unauthorized', 'unauthorized', 'rate-limited', 'unavailable', 'unavailable', 'invalid']);
	});

	test('acts only on a confident, known status', () => {
		const answer = (choice: string, confidence: number) => ({ type: 'choice' as const, choice, confidence, probabilities: {} });
		assert.deepStrictEqual([
			agentStatusFromAnswer(answer('needs_input', 0.9)),
			agentStatusFromAnswer(answer('needs_input', 0.4)),
			agentStatusFromAnswer(answer('dancing', 0.99)),
			agentStatusFromAnswer(undefined),
		], [KinguAgentTerminalStatus.NeedsInput, undefined, undefined, undefined]);
	});

	test('watches agent terminals and nothing else', () => {
		assert.deepStrictEqual([
			isAgentTerminalName('claude'),
			isAgentTerminalName('powershell', 'C:\\tools\\codex.exe'),
			isAgentTerminalName('npm run build'),
			isAgentTerminalName('claudette-server'),
			isAgentTerminalName(undefined, 'gemini'),
		], [true, true, false, false, true]);
	});

	test('tells focus moving from the user typing', () => {
		assert.deepStrictEqual(['\u001b[O', '\u001b[I\u001b[O', '1\r', '\u001b[A', ''].map(isFocusReport), [true, true, false, false, false]);
	});

	test('reads terminal output as plain text', () => {
		assert.strictEqual(plainTerminalText('\u001b[32mDone\u001b[0m\r\n50%\r100%\n\u001b]0;title\u0007❯ '), 'Done\n100%\n❯ ');
		const tail = new TerminalOutputTail(10);
		tail.append('0123456789');
		tail.append('\u001b[1mABCDE\u001b[0m');
		assert.strictEqual(tail.read(), '56789ABCDE');
	});
});
