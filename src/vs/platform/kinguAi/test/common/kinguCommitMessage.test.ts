/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildCommitMessagePrompt, cleanCommitMessage, hasCommitChanges, IKinguCommitChanges, truncateDiff } from '../../common/kinguCommitMessage.js';

suite('kinguCommitMessage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const changes: IKinguCommitChanges = {
		branch: 'main',
		staged: false,
		stat: ' a.txt | 1 +\n 1 file changed, 1 insertion(+)\n',
		diff: 'diff --git a/a.txt b/a.txt\n+b\n',
		untracked: ['b.txt'],
		recentSubjects: ['Add the sparkle', 'Fix the footer'],
	};

	test('takes fences and a lead-in off the message, and keeps its body', () => {
		assert.deepStrictEqual([
			cleanCommitMessage('```\nAdd a.txt\n\nBecause.\n```'),
			cleanCommitMessage('```gitcommit\r\nAdd a.txt\r\n```'),
			cleanCommitMessage('Here is a commit message:\n\nAdd a.txt'),
			cleanCommitMessage('  Add a.txt\n'),
		], [
			'Add a.txt\n\nBecause.',
			'Add a.txt',
			'Add a.txt',
			'Add a.txt',
		]);
	});

	test('names the branch, the style, every file and the diff, and says when nothing is staged', () => {
		const prompt = buildCommitMessagePrompt(changes);
		for (const part of ['Branch: main', '- Add the sparkle', 'nothing is staged', 'a.txt | 1 +', '- b.txt', '+b']) {
			assert.ok(prompt.includes(part), part);
		}
		assert.ok(buildCommitMessagePrompt({ ...changes, staged: true }).includes('Staged changes:'));
	});

	test('cuts a long diff, and sees nothing to describe without a diff or a new file', () => {
		assert.deepStrictEqual({
			cut: truncateDiff('x'.repeat(20), 10),
			kept: truncateDiff('short', 10),
			empty: hasCommitChanges({ ...changes, diff: ' \n', untracked: [] }),
			newFileOnly: hasCommitChanges({ ...changes, diff: '' }),
		}, {
			cut: 'x'.repeat(10) + '\n[diff truncated]',
			kept: 'short',
			empty: false,
			newFileOnly: true,
		});
	});
});
