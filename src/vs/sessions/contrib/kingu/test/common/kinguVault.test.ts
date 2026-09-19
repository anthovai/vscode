/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeClaudeProjectDirName,
	encodeClaudeProjectPath,
	findExcerpt,
	readFirstUserPrompt,
	readRecordedTitle,
	readWorkingDirectory,
	sessionTitle,
} from '../../common/kinguVault.js';

const lines = (...records: object[]) => records.map(r => JSON.stringify(r)).join('\n');

suite('Kingu vault', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('encodeClaudeProjectPath', () => {

		test('replaces every non-alphanumeric character, without collapsing runs', () => {
			// Collapsing would turn `/.claude` into `-claude` and stop matching the
			// directory Claude actually writes.
			assert.strictEqual(encodeClaudeProjectPath('/home/me/.claude'), '-home-me--claude');
		});

		// Case is preserved because Claude encodes the raw cwd: lowercasing here would
		// produce a name that never matches the directory on disk.
		test('normalizes Windows separators and keeps the drive letter cased', () => {
			assert.strictEqual(encodeClaudeProjectPath('C:\\Users\\me\\repo'), 'C--Users-me-repo');
		});

		test('keeps a bare root rather than trimming it away', () => {
			assert.strictEqual(encodeClaudeProjectPath('/'), '-');
			assert.strictEqual(encodeClaudeProjectPath('C:/'), 'C--');
		});

		test('drops a trailing separator so one directory has one encoding', () => {
			assert.strictEqual(encodeClaudeProjectPath('/home/me/repo/'), encodeClaudeProjectPath('/home/me/repo'));
		});
	});

	suite('decodeClaudeProjectDirName', () => {

		test('restores a Windows drive so the label is readable', () => {
			assert.strictEqual(decodeClaudeProjectDirName('c--Users-me-repo'), 'C:/Users/me/repo');
		});

		test('reads a posix path back as a path', () => {
			assert.strictEqual(decodeClaudeProjectDirName('-home-me-repo'), '/home/me/repo');
		});

		test('has nothing to say about an empty name', () => {
			assert.strictEqual(decodeClaudeProjectDirName(''), undefined);
		});
	});

	suite('readRecordedTitle', () => {

		test('prefers the title the session recorded for itself', () => {
			const transcript = lines(
				{ type: 'custom-title', customTitle: 'Rebranding and setup' },
				{ message: { role: 'user', content: 'do the thing' } },
			);
			assert.strictEqual(readRecordedTitle(transcript), 'Rebranding and setup');
		});

		test('stops at the first real turn instead of scanning the whole file', () => {
			// A 17MB transcript must not be walked to find a header that is not there.
			const transcript = lines(
				{ message: { role: 'user', content: 'hi' } },
				{ type: 'custom-title', customTitle: 'too late' },
			);
			assert.strictEqual(readRecordedTitle(transcript), undefined);
		});

		test('reports none for a transcript that records no title', () => {
			assert.strictEqual(readRecordedTitle(lines({ type: 'mode', mode: 'normal' })), undefined);
		});
	});

	suite('readFirstUserPrompt', () => {

		test('reads the nested message shape Claude writes', () => {
			const transcript = lines(
				{ type: 'summary' },
				{ message: { role: 'user', content: [{ type: 'text', text: 'fix the build' }] } },
				{ message: { role: 'assistant', content: 'on it' } },
			);
			assert.strictEqual(readFirstUserPrompt(transcript), 'fix the build');
		});

		test('reads the payload shape Codex writes', () => {
			const transcript = lines({ payload: { role: 'user', content: 'ship it' } });
			assert.strictEqual(readFirstUserPrompt(transcript), 'ship it');
		});

		test('reads a flat record', () => {
			assert.strictEqual(readFirstUserPrompt(lines({ role: 'user', content: 'hello' })), 'hello');
		});

		test('takes the first user turn, not a later one', () => {
			const transcript = lines(
				{ message: { role: 'user', content: 'first' } },
				{ message: { role: 'user', content: 'second' } },
			);
			assert.strictEqual(readFirstUserPrompt(transcript), 'first');
		});

		test('collapses whitespace so a pasted block stays one line', () => {
			assert.strictEqual(readFirstUserPrompt(lines({ role: 'user', content: 'a\n\n  b\tc' })), 'a b c');
		});

		test('skips a torn last line rather than failing', () => {
			// A transcript is appended to while it is read, so this is normal.
			const transcript = lines({ role: 'user', content: 'done' }) + '\n{"role":"user","cont';
			assert.strictEqual(readFirstUserPrompt(transcript), 'done');
		});

		test('has nothing to report for a transcript with no user turn', () => {
			assert.strictEqual(readFirstUserPrompt(lines({ message: { role: 'assistant', content: 'hi' } })), undefined);
			assert.strictEqual(readFirstUserPrompt(''), undefined);
		});
	});

	suite('readWorkingDirectory', () => {

		test('finds a cwd at either depth', () => {
			assert.strictEqual(readWorkingDirectory(lines({ cwd: '/repo' })), '/repo');
			assert.strictEqual(readWorkingDirectory(lines({ payload: { cwd: '/repo' } })), '/repo');
		});

		test('reports none when no record carries one', () => {
			assert.strictEqual(readWorkingDirectory(lines({ role: 'user', content: 'hi' })), undefined);
		});
	});

	suite('findExcerpt', () => {

		test('matches case-insensitively and returns the turn text', () => {
			const transcript = lines({ message: { role: 'assistant', content: 'The Build Is Green' } });
			assert.strictEqual(findExcerpt(transcript, 'build is'), 'The Build Is Green');
		});

		test('matches raw text so a hit in a tool result is still found', () => {
			const transcript = lines({ type: 'tool_result', output: 'ENOENT at /srv/app.ts' });
			assert.ok(findExcerpt(transcript, 'ENOENT')?.includes('ENOENT'));
		});

		test('truncates a long excerpt', () => {
			const transcript = lines({ role: 'assistant', content: 'x'.repeat(500) });
			const excerpt = findExcerpt(transcript, 'xxx')!;
			assert.strictEqual(excerpt.length, 201);
			assert.ok(excerpt.endsWith('…'));
		});

		test('reports nothing when the query is absent', () => {
			assert.strictEqual(findExcerpt(lines({ role: 'user', content: 'hello' }), 'goodbye'), undefined);
		});
	});

	suite('sessionTitle', () => {

		test('uses the prompt when there is one', () => {
			assert.strictEqual(sessionTitle('fix the build', 'abc.jsonl'), 'fix the build');
		});

		test('falls back to the file name, which is the only honest name left', () => {
			assert.strictEqual(sessionTitle(undefined, 'abc.jsonl'), 'abc.jsonl');
			assert.strictEqual(sessionTitle('   ', 'abc.jsonl'), 'abc.jsonl');
		});

		test('cuts a paragraph down to a list row', () => {
			const title = sessionTitle('y'.repeat(300), 'abc.jsonl');
			assert.strictEqual(title.length, 121);
			assert.ok(title.endsWith('…'));
		});
	});
});
