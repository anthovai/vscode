/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { derivedBundleName, isSkillShareEligible, isValidBundleName, parseSkillShareId, readSkillOperation, sameSkillFile, skillErrorMessage, skillsOfVersion } from '../../common/kinguSkillSharing.js';

suite('kinguSkillSharing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('names a bundle after its first skill, like the ADE', () => {
		assert.deepStrictEqual([
			derivedBundleName([]),
			derivedBundleName([{ name: 'Code Review' }]),
			derivedBundleName([{ name: 'deploy' }, { name: 'b' }, { name: 'c' }]),
			isValidBundleName('deploy-and-2-more'),
			isValidBundleName('Bad Name'),
			isValidBundleName('a--b'),
		], ['shared-skills', 'code-review', 'deploy-and-2-more', true, false, false]);
	});

	test('reads share links from our cloud, Kingu links and bare ids only', () => {
		assert.deepStrictEqual([
			parseSkillShareId('abc_DEF-123'),
			parseSkillShareId('https://cloud.anthovai.com/skills/share/abc123/'),
			parseSkillShareId('http://127.0.0.1:8787/skills/share/abc123'),
			parseSkillShareId('kingu://skills/share/abc123'),
			parseSkillShareId('http://cloud.anthovai.com/skills/share/abc123'),
			parseSkillShareId('https://example.com/skills/share/abc123'),
			parseSkillShareId('https://cloud.anthovai.com/a/abc123'),
		], ['abc_DEF-123', 'abc123', 'abc123', 'abc123', undefined, undefined, undefined]);
	});

	test('matches a SKILL.md path however Windows spells it', () => {
		assert.deepStrictEqual([
			sameSkillFile('C:\\Users\\me\\.claude\\skills\\a\\SKILL.md', 'c:/users/me/.claude/skills/a/SKILL.md'),
			sameSkillFile('/c:/Users/me/a/SKILL.md', 'C:\\Users\\me\\a\\SKILL.md'),
			sameSkillFile('/home/me/a/SKILL.md', '/home/me/b/SKILL.md'),
		], [true, true, false]);
	});

	test('reads operations, eligibility, error codes and a version\'s skills', () => {
		const skill = { id: 's', name: 's', description: null, providers: [], sourceLabel: '', installed: true, skillFilePath: '' };
		assert.deepStrictEqual([
			readSkillOperation({ status: 'ok', value: 1 }),
			readSkillOperation({ status: 'reconnect-required' }),
			readSkillOperation(undefined, new Error('Error invoking remote method: skill_share_not_found')).kind,
			skillErrorMessage(new Error('boom')),
			isSkillShareEligible({ ...skill, sourceKind: 'home' }),
			isSkillShareEligible({ ...skill, sourceKind: 'plugin' }),
			skillsOfVersion({ packageId: 'p', versionId: 'v', name: 'kit', description: '', createdAt: '', manifest: { skills: [{ id: 'a', name: 'a', description: 'A' }] } }).map(s => s.id),
		], [
			{ kind: 'ok', value: 1 },
			{ kind: 'signIn' },
			'error',
			'boom',
			true,
			false,
			['a'],
		]);
	});
});
