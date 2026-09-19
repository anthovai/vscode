/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	encodeClaudeProjectPath,
	findExcerpt,
	readFirstUserPrompt,
	readJsonDocumentDescriptor,
	readRecordedTitle,
	readWorkingDirectory,
	KinguVaultSource,
	sessionTitle,
} from '../../common/kinguVault.js';
import {
	clineMessagesPath,
	decodeClaudeProjectDirName,
	isAntigravityTranscript,
	isClineSessionManifest,
	isDiscoverable,
	KINGU_VAULT_SOURCES,
	vaultSource,
} from '../../common/kinguVaultSources.js';

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

	suite('source table', () => {

		const relative = (path: string) => path.split('/').filter(Boolean);

		test('every source the vault claims has a definition and a label', () => {
			const ids = KINGU_VAULT_SOURCES.map(source => source.id);
			assert.strictEqual(new Set(ids).size, ids.length, 'source ids must be unique');
			for (const source of KINGU_VAULT_SOURCES) {
				assert.ok(source.label.trim(), `${source.id} needs a label`);
				assert.ok(source.roots.length > 0, `${source.id} needs a root`);
				assert.ok(source.extensions.length > 0, `${source.id} needs an extension`);
			}
		});

		test('Claude surfaces a transcript but not a subagent one', () => {
			const claude = vaultSource(KinguVaultSource.Claude);
			assert.strictEqual(isDiscoverable(claude, relative('-home-me-repo/abc.jsonl')), true);
			// Subagent transcripts share their parent's id, so as rows they duplicate it.
			assert.strictEqual(isDiscoverable(claude, relative('-home-me-repo/subagents/abc.jsonl')), false);
			assert.strictEqual(isDiscoverable(claude, relative('-home-me-repo/notes.md')), false);
		});

		test('Claude recovers the working directory from the project directory name', () => {
			const claude = vaultSource(KinguVaultSource.Claude);
			assert.strictEqual(claude.workingDirectoryFromPath?.(relative('c--Users-me-repo/abc.jsonl')), 'C:/Users/me/repo');
		});

		test('Cursor takes only agent transcripts out of a project directory', () => {
			const cursor = vaultSource(KinguVaultSource.Cursor);
			assert.strictEqual(isDiscoverable(cursor, relative('proj/agent-transcripts/abc.jsonl')), true);
			assert.strictEqual(isDiscoverable(cursor, relative('proj/other/abc.jsonl')), false);
		});

		test('Cline takes the manifest named after its own directory', () => {
			const cline = vaultSource(KinguVaultSource.Cline);
			assert.strictEqual(isDiscoverable(cline, relative('abc/abc.json')), true);
			// The turns file sits beside it and is read through the manifest, not as a row.
			assert.strictEqual(isDiscoverable(cline, relative('abc/abc.messages.json')), false);
			assert.strictEqual(isDiscoverable(cline, relative('abc/other.json')), false);
		});

		test('Antigravity takes only the fixed transcript chain out of a brain directory', () => {
			const antigravity = vaultSource(KinguVaultSource.Antigravity);
			assert.strictEqual(isDiscoverable(antigravity, relative('conv1/.system_generated/logs/transcript.jsonl')), true);
			// Brain directories hold large artifact trees that are not the conversation.
			assert.strictEqual(isDiscoverable(antigravity, relative('conv1/artifacts/transcript.jsonl')), false);
			assert.strictEqual(isDiscoverable(antigravity, relative('conv1/.system_generated/logs/other.jsonl')), false);
		});

		test('Gemini accepts both spellings it has used', () => {
			const gemini = vaultSource(KinguVaultSource.Gemini);
			assert.strictEqual(isDiscoverable(gemini, relative('proj/chat.json')), true);
			assert.strictEqual(isDiscoverable(gemini, relative('proj/chat.jsonl')), true);
		});

		test('a file below a source depth is not surfaced', () => {
			const cline = vaultSource(KinguVaultSource.Cline);
			assert.strictEqual(isDiscoverable(cline, relative('a/b/b.json')), false);
		});

		test('an unknown source id is a programming error, not an empty result', () => {
			assert.throws(() => vaultSource('nope' as KinguVaultSource));
		});
	});

	suite('path helpers', () => {

		test('isClineSessionManifest matches only the self-named manifest', () => {
			assert.strictEqual(isClineSessionManifest(['abc', 'abc.json']), true);
			assert.strictEqual(isClineSessionManifest(['abc', 'def.json']), false);
			assert.strictEqual(isClineSessionManifest(['abc.json']), false);
		});

		test('clineMessagesPath names the sibling holding the turns', () => {
			assert.strictEqual(clineMessagesPath('/s/abc/abc.json'), '/s/abc/abc.messages.json');
			assert.strictEqual(clineMessagesPath('/s/abc/abc.jsonl'), undefined);
		});

		test('isAntigravityTranscript needs the whole chain, not just the file name', () => {
			assert.strictEqual(isAntigravityTranscript(['c1', '.system_generated', 'logs', 'transcript.jsonl']), true);
			assert.strictEqual(isAntigravityTranscript(['.system_generated', 'logs', 'transcript.jsonl']), false);
			assert.strictEqual(isAntigravityTranscript(['c1', 'logs', 'transcript.jsonl']), false);
		});
	});

	suite('readJsonDocumentDescriptor', () => {

		test('reads a whole document', () => {
			const document = JSON.stringify({ title: 'Ship it', directory: '/repo', other: 1 });
			assert.deepStrictEqual(readJsonDocumentDescriptor(document), { title: 'Ship it', workingDirectory: '/repo' });
		});

		test('reads the fields out of a document whose tail was cut off', () => {
			// The prefix read is bounded, so a large manifest never parses.
			const truncated = '{"id":"abc","title":"Ship it","cwd":"/repo","messages":[{"role":"user","text":"aaa';
			assert.deepStrictEqual(readJsonDocumentDescriptor(truncated), { title: 'Ship it', workingDirectory: '/repo' });
		});

		test('honours the field names each agent uses', () => {
			assert.strictEqual(readJsonDocumentDescriptor('{"workspace_root":"/w"').workingDirectory, '/w');
			assert.strictEqual(readJsonDocumentDescriptor('{"customTitle":"T"').title, 'T');
		});

		test('reports nothing rather than guessing', () => {
			assert.deepStrictEqual(readJsonDocumentDescriptor('not json at all'), { title: undefined, workingDirectory: undefined });
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

		test('reads the split shape Cursor writes, role above content', () => {
			// Cursor keeps the role at the top level and the content under `message`,
			// which matches neither of the other two layouts.
			const transcript = lines({ role: 'user', message: { content: [{ type: 'text', text: 'count the shapes' }] } });
			assert.strictEqual(readFirstUserPrompt(transcript), 'count the shapes');
		});

		test('unwraps the query out of a prompt the agent wrapped', () => {
			// Titling from the raw text would name every session of a day after its date.
			const wrapped = '<timestamp>Monday, Jul 13, 2026</timestamp>\n<user_query>\nmerge YOLO with SAM\n</user_query>';
			const transcript = lines({ role: 'user', message: { content: [{ type: 'text', text: wrapped }] } });
			assert.strictEqual(readFirstUserPrompt(transcript), 'merge YOLO with SAM');
		});

		test('drops a leading metadata tag when no query tag follows', () => {
			const transcript = lines({ role: 'user', content: '<timestamp>today</timestamp>just do it' });
			assert.strictEqual(readFirstUserPrompt(transcript), 'just do it');
		});

		test('reads the typed-item shape Codex writes, with no role field at all', () => {
			const transcript = lines(
				{ type: 'session_meta', payload: { cwd: '/repo' } },
				{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'check the system' }] } } },
			);
			assert.strictEqual(readFirstUserPrompt(transcript), 'check the system');
		});

		test('does not mistake an assistant item for the opening prompt', () => {
			const transcript = lines(
				{ payload: { item: { type: 'AssistantMessage', content: [{ type: 'text', text: 'hello' }] } } },
				{ payload: { item: { type: 'UserMessage', content: [{ type: 'text', text: 'the real one' }] } } },
			);
			assert.strictEqual(readFirstUserPrompt(transcript), 'the real one');
		});

		test('reads a flat record', () => {
			assert.strictEqual(readFirstUserPrompt(lines({ role: 'user', content: 'hello' })), 'hello');
		});

		test('skips a turn that is nothing but injected context', () => {
			// Codex opens a session with machine-written blocks; naming the session after
			// them gives every session the same title.
			const transcript = lines(
				{ payload: { item: { type: 'UserMessage', content: [{ type: 'text', text: '<recommended_plugins>a list</recommended_plugins>' }] } } },
				{ payload: { item: { type: 'UserMessage', content: [{ type: 'text', text: 'fix the parser' }] } } },
			);
			assert.strictEqual(readFirstUserPrompt(transcript), 'fix the parser');
		});

		test('keeps injected context when the user never typed anything', () => {
			// Still a better name than the file's own.
			const transcript = lines({ role: 'user', content: '<environment_context>cwd</environment_context>' });
			assert.ok(readFirstUserPrompt(transcript)?.includes('environment_context'));
		});

		test('keeps the text that follows an injected block in the same turn', () => {
			const transcript = lines({ role: 'user', content: '<environment_context>cwd</environment_context>now do it' });
			assert.strictEqual(readFirstUserPrompt(transcript), 'now do it');
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
