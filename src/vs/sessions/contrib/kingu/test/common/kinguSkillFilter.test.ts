/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKinguSkill, IKinguSkillSource, KINGU_SHARED_SKILL_OWNER } from '../../common/kinguSkills.js';
import {
	countKinguSkillsByKind,
	filterKinguSkills,
	isLongKinguSkillDescription,
	KINGU_SKILL_DESCRIPTION_CLAMP,
	KINGU_SKILL_FILTER_NONE,
	KINGU_SKILL_QUERY_MAX_LENGTH,
	kinguSkillMatchesOwner,
	kinguSkillOwnerByRoot,
	kinguSkillOwnerLabel,
	kinguSkillOwnerOptions,
} from '../../common/kinguSkillFilter.js';

function skill(overrides: Partial<IKinguSkill> & { readonly name: string }): IKinguSkill {
	const path = `/home/me/.claude/skills/${overrides.name}/SKILL.md`;
	return {
		id: path,
		description: undefined,
		providers: ['claude'],
		sourceKind: 'home',
		sourceLabel: 'Claude home',
		rootPath: '/home/me/.claude/skills',
		rootPaths: ['/home/me/.claude/skills'],
		directoryPath: `/home/me/.claude/skills/${overrides.name}`,
		directory: URI.file(`/home/me/.claude/skills/${overrides.name}`),
		resource: URI.file(path),
		updatedAt: 0,
		...overrides,
	};
}

function source(path: string, owner: string): IKinguSkillSource {
	return {
		id: path,
		label: path,
		path,
		resource: URI.file(path),
		sourceKind: 'home',
		providers: ['agent-skills'],
		owner,
		exists: true,
		skippedReason: undefined,
	};
}

const CLAUDE_ROOT = '/home/me/.claude/skills';
const SHARED_ROOT = '/home/me/.agents/skills';
const SOURCES = [source(CLAUDE_ROOT, 'claude'), source(SHARED_ROOT, KINGU_SHARED_SKILL_OWNER)];

suite('Kingu skill filter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an empty filter keeps everything', () => {
		const skills = [skill({ name: 'commit' }), skill({ name: 'review' })];
		assert.strictEqual(filterKinguSkills(skills, KINGU_SKILL_FILTER_NONE, new Map()).length, 2);
	});

	test('matches the name, the description and the path', () => {
		const skills = [
			skill({ name: 'commit', description: 'Writes a message.' }),
			skill({ name: 'review' }),
		];
		const owners = kinguSkillOwnerByRoot(SOURCES);
		const match = (query: string) => filterKinguSkills(skills, { ...KINGU_SKILL_FILTER_NONE, query }, owners).map(found => found.name);
		assert.deepStrictEqual(match('COMMIT'), ['commit']);
		assert.deepStrictEqual(match('message'), ['commit']);
		assert.deepStrictEqual(match('skills/review'), ['review']);
	});

	// Someone pasting a file into the search box is not searching, and matching
	// it costs a pass over the whole corpus to return nothing.
	test('a query past the limit matches nothing rather than everything', () => {
		const skills = [skill({ name: 'commit' })];
		const query = 'x'.repeat(KINGU_SKILL_QUERY_MAX_LENGTH + 1);
		assert.strictEqual(filterKinguSkills(skills, { ...KINGU_SKILL_FILTER_NONE, query }, new Map()).length, 0);
	});

	test('filters by kind', () => {
		const skills = [skill({ name: 'commit' }), skill({ name: 'bundled-one', sourceKind: 'bundled' })];
		const found = filterKinguSkills(skills, { ...KINGU_SKILL_FILTER_NONE, sourceKind: 'bundled' }, new Map());
		assert.deepStrictEqual(found.map(entry => entry.name), ['bundled-one']);
	});

	// The owning agent comes from the root, never from the provider list: the
	// scan tags a dozen different agents' roots as `agent-skills`.
	test('the owner comes from the root a skill was found in', () => {
		const shared = skill({ name: 'shared', rootPath: SHARED_ROOT, rootPaths: [SHARED_ROOT] });
		const owners = kinguSkillOwnerByRoot(SOURCES);
		assert.ok(kinguSkillMatchesOwner(shared, KINGU_SHARED_SKILL_OWNER, owners));
		assert.ok(!kinguSkillMatchesOwner(shared, 'claude', owners));
	});

	test('a skill reached through two roots belongs to both agents', () => {
		const both = skill({ name: 'both', rootPaths: [CLAUDE_ROOT, SHARED_ROOT] });
		const owners = kinguSkillOwnerByRoot(SOURCES);
		assert.ok(kinguSkillMatchesOwner(both, 'claude', owners));
		assert.ok(kinguSkillMatchesOwner(both, KINGU_SHARED_SKILL_OWNER, owners));
	});

	test('an empty owner is never a filter', () => {
		const owners = kinguSkillOwnerByRoot(SOURCES);
		assert.ok(!kinguSkillMatchesOwner(skill({ name: 'commit' }), '', owners));
		assert.ok(kinguSkillMatchesOwner(skill({ name: 'commit' }), 'all', owners));
	});

	test('only agents that hold a skill are offered, busiest first', () => {
		const skills = [
			skill({ name: 'a' }),
			skill({ name: 'b' }),
			skill({ name: 'c', rootPath: SHARED_ROOT, rootPaths: [SHARED_ROOT] }),
		];
		const options = kinguSkillOwnerOptions(skills, [...SOURCES, source('/home/me/.grok/skills', 'grok')]);
		assert.deepStrictEqual(options.map(option => [option.id, option.count]), [
			['claude', 2],
			[KINGU_SHARED_SKILL_OWNER, 1],
		]);
	});

	test('a skill counts once per agent even when two of its roots share one', () => {
		const duplicated = skill({ name: 'once', rootPaths: [CLAUDE_ROOT, CLAUDE_ROOT] });
		const options = kinguSkillOwnerOptions([duplicated], SOURCES);
		assert.deepStrictEqual(options.map(option => option.count), [1]);
	});

	test('counts every kind, including the ones nobody has', () => {
		const counts = countKinguSkillsByKind([skill({ name: 'a' }), skill({ name: 'b', sourceKind: 'plugin' })]);
		assert.deepStrictEqual(counts, { home: 1, repo: 0, bundled: 0, plugin: 1 });
	});

	test('the shared root is named, not left as its id', () => {
		assert.notStrictEqual(kinguSkillOwnerLabel(KINGU_SHARED_SKILL_OWNER), KINGU_SHARED_SKILL_OWNER);
		// An agent this window has never heard of is still shown, under its id.
		assert.strictEqual(kinguSkillOwnerLabel('some-new-agent'), 'some-new-agent');
	});

	test('only a description past the clamp gets a disclosure', () => {
		assert.ok(!isLongKinguSkillDescription(undefined));
		assert.ok(!isLongKinguSkillDescription('x'.repeat(KINGU_SKILL_DESCRIPTION_CLAMP)));
		assert.ok(isLongKinguSkillDescription('x'.repeat(KINGU_SKILL_DESCRIPTION_CLAMP + 1)));
	});
});
