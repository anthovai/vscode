/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KinguVaultSource } from '../../common/kinguVault.js';
import { isDiscoverable, vaultSource } from '../../common/kinguVaultSources.js';
import {
	isSubagentTranscriptName,
	readSubagentMeta,
	SUBAGENT_DIRECTORY_NAME,
	subagentMetaPathFor,
	subagentsDirectoryFor,
	subagentTitle,
} from '../../common/kinguVaultSubagents.js';

suite('Kingu vault subagents', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('subagentsDirectoryFor', () => {

		test('names the directory beside the transcript, after its own stem', () => {
			assert.strictEqual(subagentsDirectoryFor('/p/-home-me/abc.jsonl'), '/p/-home-me/abc/subagents');
		});

		test('handles a Windows-style path', () => {
			assert.strictEqual(subagentsDirectoryFor('C:\\p\\enc\\abc.jsonl'), 'C:\\p\\enc\\abc/subagents');
		});

		test('reports none for a path with no extension to strip', () => {
			assert.strictEqual(subagentsDirectoryFor('/p/enc/abc'), undefined);
			// A dot in a directory name is not an extension on the file.
			assert.strictEqual(subagentsDirectoryFor('/p/v1.2/abc'), undefined);
		});

		test('the directory it names is the one the scanner prunes', () => {
			// If these drifted, the scanner would list workers as top-level sessions
			// while this looked for them somewhere else.
			assert.ok(subagentsDirectoryFor('/p/enc/abc.jsonl')!.endsWith('/' + SUBAGENT_DIRECTORY_NAME));
			const claude = vaultSource(KinguVaultSource.Claude);
			assert.strictEqual(isDiscoverable(claude, ['enc', SUBAGENT_DIRECTORY_NAME, 'w.jsonl']), false);
		});
	});

	suite('subagentMetaPathFor', () => {

		test('names the sidecar beside the transcript', () => {
			assert.strictEqual(subagentMetaPathFor('/p/enc/abc/subagents/agent-1.jsonl'), '/p/enc/abc/subagents/agent-1.meta.json');
		});

		test('reports none for something that is not a transcript', () => {
			assert.strictEqual(subagentMetaPathFor('/p/enc/abc/subagents/agent-1.meta.json'), undefined);
		});
	});

	test('isSubagentTranscriptName separates transcripts from their sidecars', () => {
		assert.strictEqual(isSubagentTranscriptName('agent-1.jsonl'), true);
		assert.strictEqual(isSubagentTranscriptName('agent-1.meta.json'), false);
	});

	suite('readSubagentMeta', () => {

		test('reads what the parent recorded about the worker', () => {
			const meta = readSubagentMeta(JSON.stringify({ agentType: 'Explore', description: 'Map the backend', spawnDepth: 1 }));
			assert.deepStrictEqual(meta, { agentType: 'Explore', description: 'Map the backend', spawnDepth: 1 });
		});

		test('reports nothing rather than guessing when the sidecar is absent or broken', () => {
			const empty = { agentType: undefined, description: undefined, spawnDepth: undefined };
			assert.deepStrictEqual(readSubagentMeta(''), empty);
			assert.deepStrictEqual(readSubagentMeta('{"agentType":'), empty);
			assert.deepStrictEqual(readSubagentMeta('{"agentType":"   "}'), empty);
			assert.deepStrictEqual(readSubagentMeta('{"spawnDepth":"deep"}'), empty);
		});
	});

	suite('subagentTitle', () => {

		test('leads with the kind of worker and what it was asked to do', () => {
			const meta = { agentType: 'Explore', description: 'Map the backend', spawnDepth: 1 };
			assert.strictEqual(subagentTitle(meta, 'ignored prompt', 'agent-1.jsonl'), 'Explore: Map the backend');
		});

		test('falls back through description, type, prompt, then the file name', () => {
			const none = { agentType: undefined, description: undefined, spawnDepth: undefined };
			assert.strictEqual(subagentTitle({ ...none, description: 'Just this' }, 'prompt', 'f.jsonl'), 'Just this');
			assert.strictEqual(subagentTitle({ ...none, agentType: 'Plan' }, 'prompt', 'f.jsonl'), 'Plan');
			assert.strictEqual(subagentTitle(none, 'the prompt', 'f.jsonl'), 'the prompt');
			assert.strictEqual(subagentTitle(none, undefined, 'f.jsonl'), 'f.jsonl');
		});
	});

	suite('the delete invariant', () => {

		test('a path a scan would surface is deletable', () => {
			const claude = vaultSource(KinguVaultSource.Claude);
			assert.strictEqual(isDiscoverable(claude, ['-home-me-repo', 'abc.jsonl']), true);
		});

		test('a worker transcript is not deletable in its own right', () => {
			// It is reached through its parent and goes with it; on its own it is a
			// path no scan lists, which is exactly what deletion refuses.
			const claude = vaultSource(KinguVaultSource.Claude);
			assert.strictEqual(isDiscoverable(claude, ['-home-me-repo', 'abc', SUBAGENT_DIRECTORY_NAME, 'agent-1.jsonl']), false);
		});

		test('a file of the wrong shape for its source is not deletable', () => {
			const cline = vaultSource(KinguVaultSource.Cline);
			assert.strictEqual(isDiscoverable(cline, ['abc', 'abc.json']), true);
			// The turns file is deleted with its manifest, never as a target itself.
			assert.strictEqual(isDiscoverable(cline, ['abc', 'abc.messages.json']), false);
		});
	});
});
