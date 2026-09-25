/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	formatGitLabReference,
	formatGitLabTodoAction,
	formatGitLabTypeState,
	getGitLabIssueQuery,
	getGitLabStateTone,
	IKinguGitLabWorkItem,
	mergeGitLabResults,
} from '../../common/kinguTasksGitLab.js';

function item(overrides: Partial<IKinguGitLabWorkItem> & { readonly number: number; readonly updatedAt: string }): IKinguGitLabWorkItem {
	return {
		id: `gitlab-mr-r-${overrides.number}`,
		type: 'mr',
		title: `Item ${overrides.number}`,
		state: 'opened',
		url: `https://gitlab.com/group/project/-/merge_requests/${overrides.number}`,
		labels: [],
		author: 'someone',
		repoId: 'unset',
		...overrides,
	};
}

suite('kinguTasksGitLab', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('merges projects newest first, dropping not-found projects silently', () => {
		const merged = mergeGitLabResults([
			{ repoId: 'a', result: { items: [item({ number: 1, updatedAt: '2026-09-01T00:00:00Z' }), item({ number: 3, updatedAt: '2026-09-20T00:00:00Z' })] } },
			{ repoId: 'b', result: { items: [item({ number: 2, updatedAt: '2026-09-10T00:00:00Z' })] } },
			{ repoId: 'github-only', result: { items: [], error: { type: 'not_found', message: 'No GitLab project found for this repository.' } } },
			{ repoId: 'denied', result: { items: [], error: { type: 'permission_denied', message: 'no scope' } } },
			{ repoId: 'offline', result: undefined, thrown: 'Network error' },
		]);
		assert.deepStrictEqual({
			order: merged.items.map(entry => `${entry.repoId}!${entry.number}`),
			errors: merged.errors,
		}, {
			order: ['a!3', 'b!2', 'a!1'],
			errors: [{ repoId: 'denied', message: 'no scope' }, { repoId: 'offline', message: 'Network error' }],
		});
	});

	test('formats references, type and state, tones and todo actions as the ADE does', () => {
		assert.deepStrictEqual({
			mr: formatGitLabReference({ type: 'mr', number: 12 }),
			issue: formatGitLabReference({ type: 'issue', number: 7 }),
			typeState: formatGitLabTypeState({ type: 'mr', state: 'merged' }),
			tones: (['opened', 'merged', 'draft', 'closed', 'locked'] as const).map(getGitLabStateTone),
			action: formatGitLabTodoAction('review_requested'),
		}, {
			mr: '!12',
			issue: '#7',
			typeState: 'MR · merged',
			tones: ['open', 'merged', 'draft', 'closed', 'closed'],
			action: 'review requested',
		});
	});

	test('"Assigned to me" asks for the open issues assigned to @me', () => {
		assert.deepStrictEqual([getGitLabIssueQuery('opened'), getGitLabIssueQuery('assigned-to-me')], [
			{ state: 'opened', limit: 50 },
			{ state: 'opened', assignee: '@me', limit: 50 },
		]);
	});
});
