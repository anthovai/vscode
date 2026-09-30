/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatSessionStatus } from '../../../chat/common/chatSessionsService.js';
import { kinguHomeSessions } from '../../common/kinguHome.js';

suite('kinguHome', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const session = (name: string, status: ChatSessionStatus, lastActive: number, archived = false) => ({
		name, status, isArchived: () => archived, timing: { created: 0, lastRequestStarted: lastActive, lastRequestEnded: lastActive },
	});

	test('puts working and waiting chats first, then the latest, and leaves archived and empty ones out', () => {
		const sessions = [
			session('old', ChatSessionStatus.Completed, 10),
			session('new', ChatSessionStatus.Completed, 30),
			session('working', ChatSessionStatus.InProgress, 5),
			session('archived', ChatSessionStatus.Completed, 40, true),
			session('waiting', ChatSessionStatus.NeedsInput, 20),
			{ name: 'empty', status: ChatSessionStatus.Completed, isArchived: () => false, timing: { created: 50 } },
		];
		assert.deepStrictEqual(kinguHomeSessions(sessions, 4).map(entry => entry.name), ['waiting', 'working', 'new', 'old']);
		assert.deepStrictEqual(kinguHomeSessions(sessions, 2).map(entry => entry.name), ['waiting', 'working']);
	});
});
