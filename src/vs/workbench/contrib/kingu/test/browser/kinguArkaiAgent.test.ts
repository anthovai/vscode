/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessageRole } from '../../../chat/common/languageModels.js';
import { IChatAgentHistoryEntry } from '../../../chat/common/participants/chatAgents.js';
import { arkaiChatMessages } from '../../browser/kinguArkaiAgent.js';

suite('KinguArkaiAgent', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends the conversation oldest first, with Arkai as the system and past answers as the assistant', () => {
		const history = [
			{ request: { message: 'first' }, response: [{ kind: 'markdownContent', content: new MarkdownString('one') }, { kind: 'markdownContent', content: new MarkdownString(' two') }], result: {} },
			{ request: { message: 'unanswered' }, response: [], result: {} },
		] as unknown as IChatAgentHistoryEntry[];
		const messages = arkaiChatMessages({ message: 'now' }, history).map(message => ({ role: message.role, text: message.content.map(part => part.type === 'text' ? part.value : '').join('') }));
		assert.deepStrictEqual(messages, [
			{ role: ChatMessageRole.System, text: 'You are Arkai, the coding agent of Kingu.' },
			{ role: ChatMessageRole.User, text: 'first' },
			{ role: ChatMessageRole.Assistant, text: 'one two' },
			{ role: ChatMessageRole.User, text: 'unanswered' },
			{ role: ChatMessageRole.User, text: 'now' },
		]);
	});
});
