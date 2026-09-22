/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKinguSkill } from '../../common/kinguSkills.js';
import {
	KINGU_PLUGIN_SKILL_FILE_MAX_DEPTH,
	KINGU_SKILL_FILE_MAX_DEPTH,
	KINGU_SKILL_HOME_ROOTS,
	kinguSkillDirectoryMaxDepth,
	kinguSkillFileMaxDepth,
	kinguSkillSourceKind,
	kinguSkillSourceLabel,
	kinguSkillWorkspaceRoots,
	sortKinguSkills,
} from '../../common/kinguSkillSources.js';

function skill(name: string, sourceLabel: string, path: string): IKinguSkill {
	return {
		id: path,
		name,
		description: undefined,
		providers: ['agent-skills'],
		sourceKind: 'home',
		sourceLabel,
		rootPath: '/root',
		rootPaths: ['/root'],
		directoryPath: path,
		directory: URI.file(path),
		resource: URI.file(path),
		updatedAt: 0,
	};
}

suite('Kingu skill sources', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every root has a distinct id', () => {
		const ids = KINGU_SKILL_HOME_ROOTS.map(root => root.id);
		assert.strictEqual(new Set(ids).size, ids.length);
	});

	test('every root is below the home directory, not an absolute path', () => {
		for (const root of KINGU_SKILL_HOME_ROOTS) {
			assert.ok(root.segments.length > 0, `${root.id} has no path`);
			assert.ok(!root.segments[0].startsWith('/'), `${root.id} is absolute`);
		}
	});

	// Two open folders can share a basename; keyed on the name alone they would
	// collapse into one row and half the skills would be attributed to the wrong
	// project.
	test('two folders of one name produce distinct root ids', () => {
		const first = kinguSkillWorkspaceRoots('api', '0');
		const second = kinguSkillWorkspaceRoots('api', '1');
		assert.strictEqual(new Set([...first, ...second].map(root => root.id)).size, first.length + second.length);
	});

	test('the directory bound is one level above the file bound', () => {
		assert.strictEqual(kinguSkillFileMaxDepth('home'), KINGU_SKILL_FILE_MAX_DEPTH);
		assert.strictEqual(kinguSkillFileMaxDepth('plugin'), KINGU_PLUGIN_SKILL_FILE_MAX_DEPTH);
		assert.strictEqual(kinguSkillDirectoryMaxDepth('home'), KINGU_SKILL_FILE_MAX_DEPTH - 1);
		assert.strictEqual(kinguSkillDirectoryMaxDepth('plugin'), KINGU_PLUGIN_SKILL_FILE_MAX_DEPTH - 1);
	});

	test('a home root .system subtree is what the agent shipped with', () => {
		assert.strictEqual(kinguSkillSourceKind('home', ['.system', 'commit', 'SKILL.md']), 'bundled');
		assert.strictEqual(kinguSkillSourceKind('home', ['commit', 'SKILL.md']), 'home');
		// Only a home root: a workspace `.system` directory is the user's own.
		assert.strictEqual(kinguSkillSourceKind('repo', ['.system', 'commit', 'SKILL.md']), 'repo');
		assert.strictEqual(kinguSkillSourceKind('plugin', ['.system', 'commit', 'SKILL.md']), 'plugin');
	});

	test('a bundled skill is labelled as its root plus bundled', () => {
		assert.strictEqual(kinguSkillSourceLabel('Claude home', 'bundled', 'home'), 'Claude home bundled');
		assert.strictEqual(kinguSkillSourceLabel('Claude home', 'home', 'home'), 'Claude home');
	});

	test('rows sort by name, then source, then path', () => {
		const sorted = sortKinguSkills([
			skill('review', 'Claude home', '/b'),
			skill('commit', 'Grok home', '/c'),
			skill('commit', 'Claude home', '/d'),
			skill('commit', 'Claude home', '/a'),
		]);
		assert.deepStrictEqual(sorted.map(entry => [entry.name, entry.sourceLabel, entry.directoryPath]), [
			['commit', 'Claude home', '/a'],
			['commit', 'Claude home', '/d'],
			['commit', 'Grok home', '/c'],
			['review', 'Claude home', '/b'],
		]);
	});
});
