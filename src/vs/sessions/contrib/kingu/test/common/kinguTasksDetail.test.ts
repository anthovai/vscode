/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	getAddCommentRequest,
	getStartWorkspacePrompt,
	getTaskDetailRequests,
	getTaskReference,
	IKinguTaskRef,
	readAddCommentResult,
	readTaskDetail,
} from '../../common/kinguTasksDetail.js';

const repo = { id: 'r1', path: 'E:/code/app', displayName: 'app' };

const github: IKinguTaskRef = {
	provider: 'github',
	repo,
	item: { id: 'i1', type: 'pr', number: 12, title: 'Fix login', state: 'open', url: 'https://github.com/o/app/pull/12', labels: [], updatedAt: '2026-09-20T00:00:00Z', author: 'ann', repoId: 'r1' },
};
const gitlab: IKinguTaskRef = {
	provider: 'gitlab',
	repo,
	item: { id: 'g1', type: 'mr', number: 3, title: 'Speed up', state: 'opened', url: 'https://gitlab.com/g/app/-/merge_requests/3', labels: [], updatedAt: '2026-09-20T00:00:00Z', author: 'bo', repoId: 'r1' },
};
const jira: IKinguTaskRef = {
	provider: 'jira',
	issue: { id: '10', key: 'ABC-7', siteId: 's1', title: 'Crash', url: 'https://x.atlassian.net/browse/ABC-7', project: { key: 'ABC' }, status: { id: '1', name: 'To Do', categoryKey: 'new' }, labels: [], updatedAt: '2026-09-20T00:00:00Z' },
};
const linear: IKinguTaskRef = {
	provider: 'linear',
	issue: { id: 'lin-1', identifier: 'ENG-5', title: 'Docs', url: 'https://linear.app/t/issue/ENG-5', state: { name: 'Todo', color: '#aaa' }, priority: 0, team: { id: 't', name: 'Eng' }, labels: [], updatedAt: '2026-09-20T00:00:00Z' },
};

suite('kinguTasksDetail', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('references and start prompts follow the ADE per provider', () => {
		assert.deepStrictEqual([github, gitlab, jira, linear].map(ref => [getTaskReference(ref), getStartWorkspacePrompt(ref)]), [
			['#12', 'Complete https://github.com/o/app/pull/12'],
			['!3', 'Complete https://gitlab.com/g/app/-/merge_requests/3'],
			['ABC-7', 'Linked work items:\n- https://x.atlassian.net/browse/ABC-7'],
			['ENG-5', 'Linked Linear issue: ENG-5\nhttps://linear.app/t/issue/ENG-5'],
		]);
	});

	test('detail and comment calls carry each provider\'s selector', () => {
		assert.deepStrictEqual({
			details: [github, gitlab, jira, linear].map(ref => getTaskDetailRequests(ref).map(request => request.channel)),
			gitlabMr: getAddCommentRequest(gitlab, 'hi'),
			jira: getAddCommentRequest(jira, 'hi'),
			linear: getAddCommentRequest(linear, 'hi'),
		}, {
			details: [['gh:workItemDetails'], ['gitlab:workItemDetails'], ['jira:getIssue', 'jira:issueComments'], ['linear:getIssue', 'linear:issueComments']],
			gitlabMr: { channel: 'gitlab:addMRComment', args: { repoPath: 'E:/code/app', repoId: 'r1', iid: 3, body: 'hi' } },
			jira: { channel: 'jira:addIssueComment', args: { key: 'ABC-7', body: 'hi', siteId: 's1' } },
			linear: { channel: 'linear:addIssueComment', args: { issueId: 'lin-1', body: 'hi' } },
		});
	});

	test('reads details oldest comment first, and a missing comment list as none', () => {
		const repoHost = readTaskDetail(github, [{
			body: 'Steps',
			assignees: ['ann', 'cy'],
			files: [{}, {}],
			comments: [
				{ id: 2, author: 'cy', authorAvatarUrl: '', body: 'later', createdAt: '2026-09-21T00:00:00Z', url: 'u2', path: 'src/a.ts' },
				{ id: 1, author: '', authorAvatarUrl: 'a.png', body: 'first', createdAt: '2026-09-20T00:00:00Z', url: 'u1' },
			],
		}]);
		const jiraDetail = readTaskDetail(jira, [{ description: 'Boom', issueType: { name: 'Bug' }, reporter: { displayName: 'Dee' } }, undefined]);
		assert.deepStrictEqual({ repoHost, jiraDetail }, {
			repoHost: {
				body: 'Steps',
				comments: [
					{ id: '1', author: 'Unknown', avatarUrl: 'a.png', body: 'first', createdAt: '2026-09-20T00:00:00Z', url: 'u1', path: undefined },
					{ id: '2', author: 'cy', avatarUrl: undefined, body: 'later', createdAt: '2026-09-21T00:00:00Z', url: 'u2', path: 'src/a.ts' },
				],
				facts: [
					{ label: 'Project', value: 'app' },
					{ label: 'Author', value: 'ann' },
					{ label: 'Assignees', value: 'ann, cy' },
					{ label: 'Files changed', value: '2' },
				],
			},
			jiraDetail: {
				body: 'Boom',
				comments: [],
				facts: [
					{ label: 'Type', value: 'Bug' },
					{ label: 'Project', value: 'ABC' },
					{ label: 'Assignee', value: 'Unassigned' },
					{ label: 'Reporter', value: 'Dee' },
				],
			},
		});
	});

	test('a posted comment comes back whole, as an id only, or as an error', () => {
		const now = new Date('2026-09-25T10:00:00Z');
		assert.deepStrictEqual([
			readAddCommentResult({ ok: true, comment: { id: 9, author: 'ann', authorAvatarUrl: '', body: 'ok', createdAt: '2026-09-25T09:00:00Z', url: 'u' } }, 'ok', now),
			readAddCommentResult({ ok: true, id: 'c1' }, 'typed', now),
			readAddCommentResult({ ok: false, error: 'no scope' }, 'typed', now),
		], [
			{ ok: true, comment: { id: '9', author: 'ann', avatarUrl: undefined, body: 'ok', createdAt: '2026-09-25T09:00:00Z', url: 'u', path: undefined } },
			{ ok: true, comment: { id: 'c1', author: 'You', body: 'typed', createdAt: '2026-09-25T10:00:00.000Z' } },
			{ ok: false, error: 'no scope' },
		]);
	});
});
