/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MessageKind, ResponsePartKind, TurnState } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { readTranscriptExchanges } from '../../common/kinguVault.js';
import { MAX_IMPORTED_EXCHANGES, transcriptToTurns } from '../../common/kinguVaultTurns.js';

const lines = (...records: object[]) => records.map(r => JSON.stringify(r)).join('\n');
const user = (text: string, extra: object = {}) => ({ role: 'user', content: text, ...extra });
const assistant = (text: string) => ({ role: 'assistant', content: text });

let counter = 0;
const ids = () => `id-${++counter}`;

suite('Kingu vault turns', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => { counter = 0; });

	suite('readTranscriptExchanges', () => {

		test('pairs a question with the answer that follows it', () => {
			const exchanges = readTranscriptExchanges(lines(user('fix the build'), assistant('done')));
			assert.deepStrictEqual(exchanges.map(e => [e.prompt, e.response]), [['fix the build', 'done']]);
		});

		test('joins an answer split across records, which is how it streamed', () => {
			const exchanges = readTranscriptExchanges(lines(user('explain'), assistant('first'), assistant('second')));
			assert.strictEqual(exchanges[0].response, 'first\n\nsecond');
		});

		test('closes an exchange when the next question arrives', () => {
			const exchanges = readTranscriptExchanges(lines(user('one'), assistant('a'), user('two'), assistant('b')));
			assert.deepStrictEqual(exchanges.map(e => [e.prompt, e.response]), [['one', 'a'], ['two', 'b']]);
		});

		test('keeps a question that was never answered', () => {
			// The session was abandoned mid-question; the question is still history.
			const exchanges = readTranscriptExchanges(lines(user('are you there')));
			assert.deepStrictEqual(exchanges, [{ prompt: 'are you there', response: '', startedAt: undefined }]);
		});

		test('injected context neither opens an exchange nor interrupts an answer', () => {
			const exchanges = readTranscriptExchanges(lines(
				user('<environment_context>cwd</environment_context>'),
				user('the real question'),
				assistant('first half'),
				user('<recommended_plugins>list</recommended_plugins>'),
				assistant('second half'),
			));
			assert.strictEqual(exchanges.length, 1);
			assert.strictEqual(exchanges[0].prompt, 'the real question');
			assert.strictEqual(exchanges[0].response, 'first half\n\nsecond half');
		});

		test('ignores an answer with no question before it', () => {
			assert.deepStrictEqual(readTranscriptExchanges(lines(assistant('orphan'))), []);
		});

		test('carries the timestamp the record kept', () => {
			const exchanges = readTranscriptExchanges(lines(user('hi', { timestamp: '2026-09-20T00:00:00.000Z' })));
			assert.strictEqual(exchanges[0].startedAt, '2026-09-20T00:00:00.000Z');
		});

		test('reads the shapes the other agents write', () => {
			const codex = lines(
				{ payload: { item: { type: 'UserMessage', content: [{ type: 'text', text: 'codex question' }] } } },
				{ payload: { item: { type: 'AssistantMessage', content: [{ type: 'text', text: 'codex answer' }] } } },
			);
			assert.deepStrictEqual(readTranscriptExchanges(codex).map(e => [e.prompt, e.response]), [['codex question', 'codex answer']]);

			const cursor = lines(
				{ role: 'user', message: { content: [{ type: 'text', text: '<user_query>cursor question</user_query>' }] } },
				{ role: 'assistant', message: { content: [{ type: 'text', text: 'cursor answer' }] } },
			);
			assert.deepStrictEqual(readTranscriptExchanges(cursor).map(e => [e.prompt, e.response]), [['cursor question', 'cursor answer']]);
		});
	});

	suite('transcriptToTurns', () => {

		test('builds a user-originated turn with the answer as markdown', () => {
			const [turn] = transcriptToTurns(lines(user('fix it'), assistant('fixed')), ids);
			assert.strictEqual(turn.message.text, 'fix it');
			assert.strictEqual(turn.message.origin.kind, MessageKind.User);
			assert.strictEqual(turn.state, TurnState.Complete);
			assert.strictEqual(turn.usage, undefined);
			assert.deepStrictEqual(turn.responseParts, [{ kind: ResponsePartKind.Markdown, id: 'id-2', content: 'fixed' }]);
		});

		test('gives every turn and part its own identity', () => {
			const turns = transcriptToTurns(lines(user('a'), assistant('x'), user('b'), assistant('y')), ids);
			const partIds = turns.flatMap(t => t.responseParts.map(p => p.kind === ResponsePartKind.Markdown ? p.id : ''));
			const identities = [...turns.map(t => t.id), ...partIds];
			assert.strictEqual(new Set(identities).size, identities.length);
		});

		test('an unanswered turn carries no response parts', () => {
			const [turn] = transcriptToTurns(lines(user('hello')), ids);
			assert.deepStrictEqual(turn.responseParts, []);
		});

		test('omits startedAt rather than inventing one', () => {
			const [turn] = transcriptToTurns(lines(user('hello')), ids);
			assert.strictEqual(turn.startedAt, undefined);
		});

		test('keeps the most recent exchanges when a session is long', () => {
			// The oldest turns are the least useful and the whole history is more
			// context than the agent will take.
			const records = [];
			for (let i = 0; i < MAX_IMPORTED_EXCHANGES + 10; i++) {
				records.push(user(`question ${i}`), assistant(`answer ${i}`));
			}
			const turns = transcriptToTurns(lines(...records), ids);
			assert.strictEqual(turns.length, MAX_IMPORTED_EXCHANGES);
			assert.strictEqual(turns[0].message.text, 'question 10');
			assert.strictEqual(turns.at(-1)!.message.text, `question ${MAX_IMPORTED_EXCHANGES + 9}`);
		});

		test('a transcript with no conversation produces nothing to import', () => {
			assert.deepStrictEqual(transcriptToTurns(lines({ type: 'session_meta' }), ids), []);
			assert.deepStrictEqual(transcriptToTurns('', ids), []);
		});
	});
});
