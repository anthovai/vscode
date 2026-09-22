/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { summarizeKinguSkill } from '../../common/kinguSkillMetadata.js';

suite('Kingu skill metadata', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the declared name and description', () => {
		const summary = summarizeKinguSkill([
			'---',
			'name: commit',
			'description: Writes a commit message from the staged diff.',
			'---',
			'',
			'# Not this heading',
		].join('\n'));
		assert.strictEqual(summary.name, 'commit');
		assert.strictEqual(summary.description, 'Writes a commit message from the staged diff.');
	});

	test('unwraps quoted values', () => {
		const summary = summarizeKinguSkill('---\nname: "commit"\ndescription: \'Does a thing.\'\n---\n');
		assert.strictEqual(summary.name, 'commit');
		assert.strictEqual(summary.description, 'Does a thing.');
	});

	test('folds a block scalar onto one line', () => {
		const summary = summarizeKinguSkill([
			'---',
			'name: review',
			'description: |',
			'  Reviews a diff',
			'  across several lines.',
			'---',
		].join('\n'));
		assert.strictEqual(summary.description, 'Reviews a diff across several lines.');
	});

	test('falls back to the first heading and paragraph', () => {
		const summary = summarizeKinguSkill([
			'# Deploy',
			'',
			'Pushes the current branch and waits for the checks.',
		].join('\n'));
		assert.strictEqual(summary.name, 'Deploy');
		assert.strictEqual(summary.description, 'Pushes the current branch and waits for the checks.');
	});

	test('skips a fenced block before the first paragraph', () => {
		const summary = summarizeKinguSkill([
			'# Deploy',
			'',
			'```bash',
			'npm run deploy',
			'```',
			'',
			'Then it waits.',
		].join('\n'));
		assert.strictEqual(summary.description, 'Then it waits.');
	});

	test('a skill that says nothing is summarized as nothing', () => {
		const summary = summarizeKinguSkill('---\n---\n\n');
		assert.strictEqual(summary.name, undefined);
		assert.strictEqual(summary.description, undefined);
	});

	test('a front matter block that is not closed is body, not metadata', () => {
		const summary = summarizeKinguSkill('---\nname: half\n\n# Real title\n');
		assert.strictEqual(summary.name, 'Real title');
	});

	// The names come out of files this window did not write, and a row that can
	// be redrawn by its own contents is a row that can lie about what it is.
	test('strips the codepoints that let a name redraw a row', () => {
		const summary = summarizeKinguSkill('---\nname: "de‮ploy"\ndescription: "a​b"\n---\n');
		assert.strictEqual(summary.name, 'deploy');
		assert.strictEqual(summary.description, 'ab');
	});

	test('a name that is only unsafe characters is no name at all', () => {
		const summary = summarizeKinguSkill('---\nname: "‮​"\n---\n');
		assert.strictEqual(summary.name, undefined);
	});

	test('tolerates a leading byte order mark and CRLF line endings', () => {
		const summary = summarizeKinguSkill('﻿---\r\nname: commit\r\n---\r\n');
		assert.strictEqual(summary.name, 'commit');
	});
});
