/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionStatus } from '../../../../services/sessions/common/session.js';
import {
	buildKinguActivityGroups,
	countUnreadKinguActivity,
	IKinguActivityRow,
	KINGU_ACTIVITY_QUERY_MAX_LENGTH,
	KinguActivityStatus,
	kinguActivityMatchesQuery,
	kinguActivityStatus,
	kinguActivityStatusRank,
	sortKinguActivityRows,
} from '../../common/kinguActivity.js';

function row(overrides: Partial<IKinguActivityRow> & { readonly title: string }): IKinguActivityRow {
	return {
		sessionId: `id:${overrides.title}`,
		resource: URI.parse(`session:/${overrides.title}`),
		status: KinguActivityStatus.Done,
		agentLabel: 'copilot-cli',
		projectLabel: 'api',
		detail: undefined,
		updatedAt: 0,
		isRead: true,
		...overrides,
	};
}

suite('Kingu activity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps every session status onto an activity status', () => {
		assert.strictEqual(kinguActivityStatus(SessionStatus.NeedsInput, false), KinguActivityStatus.NeedsInput);
		assert.strictEqual(kinguActivityStatus(SessionStatus.InProgress, false), KinguActivityStatus.Working);
		assert.strictEqual(kinguActivityStatus(SessionStatus.Error, false), KinguActivityStatus.Failed);
		assert.strictEqual(kinguActivityStatus(SessionStatus.Completed, false), KinguActivityStatus.Done);
		assert.strictEqual(kinguActivityStatus(SessionStatus.Untitled, false), KinguActivityStatus.Draft);
	});

	// An archived session is not waiting on anyone, whatever it was doing when
	// it was put away — otherwise it would hold the top of the page for ever.
	test('archived beats whatever the session was doing', () => {
		assert.strictEqual(kinguActivityStatus(SessionStatus.NeedsInput, true), KinguActivityStatus.Archived);
		assert.strictEqual(kinguActivityStatus(SessionStatus.InProgress, true), KinguActivityStatus.Archived);
	});

	test('attention outranks activity, and activity outranks completion', () => {
		const rank = kinguActivityStatusRank;
		assert.ok(rank(KinguActivityStatus.NeedsInput) < rank(KinguActivityStatus.Working));
		assert.ok(rank(KinguActivityStatus.Working) < rank(KinguActivityStatus.Failed));
		assert.ok(rank(KinguActivityStatus.Failed) < rank(KinguActivityStatus.Done));
		assert.ok(rank(KinguActivityStatus.Done) < rank(KinguActivityStatus.Archived));
	});

	test('rows sort most recently touched first', () => {
		const sorted = sortKinguActivityRows([
			row({ title: 'old', updatedAt: 1 }),
			row({ title: 'new', updatedAt: 3 }),
			row({ title: 'mid', updatedAt: 2 }),
		]);
		assert.deepStrictEqual(sorted.map(entry => entry.title), ['new', 'mid', 'old']);
	});

	// The whole point of the page: a session needing an answer cannot be pushed
	// below a busier one that needs nothing, however long ago it last spoke.
	test('status headers order by attention, not by recency', () => {
		const groups = buildKinguActivityGroups([
			row({ title: 'busy', status: KinguActivityStatus.Working, updatedAt: 100 }),
			row({ title: 'finished', status: KinguActivityStatus.Done, updatedAt: 99 }),
			row({ title: 'stuck', status: KinguActivityStatus.NeedsInput, updatedAt: 1 }),
		], 'status');
		assert.deepStrictEqual(groups.map(group => group.rows[0].title), ['stuck', 'busy', 'finished']);
	});

	test('a status group carries its status so the header can draw the row dot', () => {
		const groups = buildKinguActivityGroups([row({ title: 'a', status: KinguActivityStatus.Failed })], 'status');
		assert.strictEqual(groups[0].status, KinguActivityStatus.Failed);
	});

	test('grouping by project keeps the incoming order within a group', () => {
		const groups = buildKinguActivityGroups([
			row({ title: 'a', projectLabel: 'api', updatedAt: 3 }),
			row({ title: 'b', projectLabel: 'web', updatedAt: 2 }),
			row({ title: 'c', projectLabel: 'api', updatedAt: 1 }),
		], 'project');
		assert.deepStrictEqual(groups.map(group => [group.label, group.rows.map(entry => entry.title)]), [
			['api', ['a', 'c']],
			['web', ['b']],
		]);
		assert.strictEqual(groups[0].status, undefined);
	});

	test('a session with no workspace groups under its own heading', () => {
		const groups = buildKinguActivityGroups([row({ title: 'quick', projectLabel: undefined })], 'project');
		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].key, 'project:none');
		assert.notStrictEqual(groups[0].label, '');
	});

	test('grouping by nothing is one unlabelled group, and no rows are no groups', () => {
		assert.deepStrictEqual(buildKinguActivityGroups([], 'none'), []);
		const groups = buildKinguActivityGroups([row({ title: 'a' }), row({ title: 'b' })], 'none');
		assert.deepStrictEqual(groups.map(group => [group.key, group.label, group.rows.length]), [['all', '', 2]]);
	});

	test('search matches the title, the agent, the project and the detail', () => {
		const entry = row({ title: 'fix the parser', agentLabel: 'claude-cli', projectLabel: 'compiler', detail: 'running tests' });
		assert.ok(kinguActivityMatchesQuery(entry, 'PARSER'));
		assert.ok(kinguActivityMatchesQuery(entry, 'claude'));
		assert.ok(kinguActivityMatchesQuery(entry, 'compiler'));
		assert.ok(kinguActivityMatchesQuery(entry, 'running'));
		assert.ok(!kinguActivityMatchesQuery(entry, 'nothing here'));
	});

	test('search matches the status label, which is what the row shows', () => {
		assert.ok(kinguActivityMatchesQuery(row({ title: 'a', status: KinguActivityStatus.NeedsInput }), 'needs input'));
	});

	test('an empty or whitespace query keeps everything', () => {
		assert.ok(kinguActivityMatchesQuery(row({ title: 'a' }), ''));
		assert.ok(kinguActivityMatchesQuery(row({ title: 'a' }), '   '));
	});

	test('a query past the limit matches nothing rather than everything', () => {
		assert.ok(!kinguActivityMatchesQuery(row({ title: 'a' }), 'a'.repeat(KINGU_ACTIVITY_QUERY_MAX_LENGTH + 1)));
	});

	test('counts only the rows nobody has looked at', () => {
		assert.strictEqual(countUnreadKinguActivity([
			row({ title: 'a', isRead: false }),
			row({ title: 'b', isRead: true }),
			row({ title: 'c', isRead: false }),
		]), 2);
	});
});
