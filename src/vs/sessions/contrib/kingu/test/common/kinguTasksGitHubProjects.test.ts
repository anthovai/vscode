/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	getProjectFieldEditor,
	IKinguProjectField,
	IKinguProjectRow,
	optimisticProjectFieldValue,
	projectInputMutation,
	projectRowRepository,
	withProjectFieldValue,
} from '../../common/kinguTasksGitHubProjects.js';

const status: IKinguProjectField = { kind: 'single-select', id: 'status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'todo', name: 'Todo', color: 'GRAY' }, { id: 'done', name: 'Done', color: 'GREEN' }] };
const sprint: IKinguProjectField = { kind: 'iteration', id: 'sprint', name: 'Sprint', dataType: 'ITERATION', iterations: [{ id: 'it1', title: 'Sprint 1', startDate: '2026-09-21', duration: 14, completed: false }] };
const text = (dataType: string): IKinguProjectField => ({ kind: 'field', id: dataType.toLowerCase(), name: dataType, dataType });

function row(itemType: IKinguProjectRow['itemType'], repository: string | null = 'o/app'): IKinguProjectRow {
	return {
		id: 'item', itemType,
		content: { number: 1, title: 'T', url: null, state: null, isDraft: null, repository, assignees: [], labels: [], parentIssue: null },
		fieldValuesByFieldId: { status: { kind: 'single-select', fieldId: 'status', optionId: 'todo', name: 'Todo', color: 'GRAY' } },
		updatedAt: '2026-09-26T00:00:00Z', position: 0,
	};
}

suite('kinguTasksGitHubProjects editing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks each cell’s editor, and none for redacted rows or a draft’s labels', () => {
		const issue = row('ISSUE');
		assert.deepStrictEqual({
			issue: [status, sprint, text('TEXT'), text('NUMBER'), text('DATE'), text('LABELS'), text('ASSIGNEES'), text('REPOSITORY'), text('TITLE')].map(field => getProjectFieldEditor(field, issue) ?? null),
			draft: [text('LABELS'), text('TEXT')].map(field => getProjectFieldEditor(field, row('DRAFT_ISSUE', null)) ?? null),
			redacted: getProjectFieldEditor(status, row('REDACTED')) ?? null,
		}, {
			issue: ['select', 'select', 'text', 'number', 'date', 'labels', 'assignees', null, null],
			draft: [null, 'text'],
			redacted: null,
		});
	});

	test('names and colours an optimistic value from the field, and sets or clears it on the row', () => {
		const done = optimisticProjectFieldValue(status, { kind: 'single-select', optionId: 'done' });
		assert.deepStrictEqual({
			done,
			sprint: optimisticProjectFieldValue(sprint, { kind: 'iteration', iterationId: 'it1' }),
			unknownOption: optimisticProjectFieldValue(status, { kind: 'single-select', optionId: 'gone' }) ?? null,
			set: withProjectFieldValue(row('ISSUE'), 'status', done).fieldValuesByFieldId,
			cleared: withProjectFieldValue(row('ISSUE'), 'status', undefined).fieldValuesByFieldId,
		}, {
			done: { kind: 'single-select', fieldId: 'status', optionId: 'done', name: 'Done', color: 'GREEN' },
			sprint: { kind: 'iteration', fieldId: 'sprint', iterationId: 'it1', title: 'Sprint 1', startDate: '2026-09-21', duration: 14 },
			unknownOption: null,
			set: { status: { kind: 'single-select', fieldId: 'status', optionId: 'done', name: 'Done', color: 'GREEN' } },
			cleared: {},
		});
	});

	test('typed input sets, clears, or leaves a field as the ADE commits it', () => {
		const current = { kind: 'number' as const, fieldId: 'n', number: 3 };
		assert.deepStrictEqual([
			projectInputMutation('number', ' 5 ', current),
			projectInputMutation('number', '3', current),
			projectInputMutation('number', 'abc', current),
			projectInputMutation('number', '', current),
			projectInputMutation('text', '', undefined),
			projectInputMutation('date', '2026-10-01', undefined),
		], [
			{ kind: 'number', number: 5 },
			undefined,
			undefined,
			null,
			undefined,
			{ kind: 'date', date: '2026-10-01' },
		]);
	});

	test('reads a row’s repository as owner and name', () => {
		assert.deepStrictEqual([projectRowRepository(row('ISSUE', 'octo/app')), projectRowRepository(row('ISSUE', null)) ?? null], [{ owner: 'octo', repo: 'app' }, null]);
	});
});
