/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import {
	getProjectFieldEditor,
	IKinguProjectField,
	IKinguProjectFieldValue,
	IKinguProjectRow,
	KinguProjectFieldMutation,
	optimisticProjectFieldValue,
	projectInputMutation,
	projectRowRepository,
	withProjectFieldValue,
} from '../common/kinguTasksGitHubProjects.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';

/** The ADE's `GitHubProjectMutationResult`. */
type MutationResult = { readonly ok: true } | { readonly ok: false; readonly error?: { readonly message?: string } };

export interface IKinguProjectEditHost {
	projectId(): string;
	host(): string | undefined;
	/** The row as the table holds it now, which may be newer than the one a cell was drawn from. */
	getRow(id: string): IKinguProjectRow | undefined;
	/** Puts a changed row in the table and draws it again. */
	replaceRow(row: IKinguProjectRow): void;
}

/**
 * The ADE's editable project cells (`ProjectCellSelectionEditors.tsx`,
 * `ProjectCellValueEditors.tsx`, `ProjectCellRepositoryEditors.tsx` and
 * `useProjectRowMutations.ts`): a single select or iteration picks from a list
 * with Clear, text and numbers are typed in place, a date uses the date input,
 * labels and assignees toggle one at a time. Every change shows at once and is
 * put back if GitHub refuses it; nothing is fetched again after it succeeds.
 */
export class KinguProjectCellEditors extends Disposable {

	private readonly _candidates = new Map<string, Promise<readonly string[]>>();

	constructor(
		private readonly _host: IKinguProjectEditHost,
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
	}

	/**
	 * Makes a drawn cell editable, when its field is. `redraw` draws the cell's
	 * read-only content again, after an inline input is dismissed.
	 */
	attach(cell: HTMLElement, row: IKinguProjectRow, field: IKinguProjectField, redraw: () => void): IDisposable {
		const editor = getProjectFieldEditor(field, row);
		if (!editor) {
			return Disposable.None;
		}
		const store = new DisposableStore();
		cell.classList.add('editable');
		cell.tabIndex = 0;
		cell.setAttribute('role', 'button');
		cell.setAttribute('aria-label', localize('kingu.tasks.projects.editField', "Edit {0}", field.name));
		if (cell.childElementCount === 0 && !cell.textContent) {
			append(cell, $('span.kingu-tasks-gh-projects-placeholder')).textContent = editor === 'select' || editor === 'labels' || editor === 'assignees'
				? localize('kingu.tasks.projects.select', "Select")
				: localize('kingu.tasks.projects.empty', "Empty");
		}
		const open = () => {
			const current = this._host.getRow(row.id) ?? row;
			switch (editor) {
				case 'select': return this._showSelect(cell, current, field);
				case 'labels': return this._showToggles(cell, current, 'labels');
				case 'assignees': return this._showToggles(cell, current, 'assignees');
				default: return this._showInput(cell, current, field, editor, redraw);
			}
		};
		store.add(addDisposableListener(cell, EventType.CLICK, event => {
			// Links and buttons inside the cell keep their own click.
			if ((event.target as HTMLElement).closest('button, a, input')) {
				return;
			}
			open();
		}));
		store.add(addDisposableListener(cell, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.target === cell && (event.key === 'Enter' || event.key === ' ')) {
				event.preventDefault();
				open();
			}
		}));
		return store;
	}

	// #region Field values

	private async _setField(row: IKinguProjectRow, field: IKinguProjectField, mutation: KinguProjectFieldMutation | null): Promise<void> {
		const value: IKinguProjectFieldValue | undefined = mutation ? optimisticProjectFieldValue(field, mutation) : undefined;
		if (mutation && !value) {
			return;
		}
		const previous = row;
		this._host.replaceRow(withProjectFieldValue(row, field.id, value));
		const selector = { projectId: this._host.projectId(), host: this._host.host(), itemId: row.id, fieldId: field.id };
		const result = await this._mutate(mutation
			? this._orca.invoke<MutationResult>('gh:updateProjectItemField', { ...selector, value: mutation })
			: this._orca.invoke<MutationResult>('gh:clearProjectItemField', selector));
		if (!result.ok) {
			this._rollback(previous, field.id, value);
			this._notificationService.error(result.error?.message || localize('kingu.tasks.projects.updateFailed', "Could not update {0}.", field.name));
		}
	}

	/** Puts a field back, unless something newer has already changed it. */
	private _rollback(previous: IKinguProjectRow, fieldId: string, optimistic: IKinguProjectFieldValue | undefined): void {
		const now = this._host.getRow(previous.id);
		if (now && now.fieldValuesByFieldId[fieldId] === optimistic) {
			this._host.replaceRow(withProjectFieldValue(now, fieldId, previous.fieldValuesByFieldId[fieldId]));
		}
	}

	private async _mutate(call: Promise<MutationResult>): Promise<MutationResult> {
		try {
			return await call ?? { ok: false };
		} catch (error) {
			return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
		}
	}

	private _showSelect(cell: HTMLElement, row: IKinguProjectRow, field: IKinguProjectField): void {
		const selected = row.fieldValuesByFieldId[field.id];
		const choices: { readonly id: string; readonly label: string; readonly detail?: string; readonly color?: string; readonly group?: string }[] = field.kind === 'single-select'
			? field.options.map(option => ({ id: option.id, label: option.name, color: option.color }))
			: field.kind === 'iteration'
				? [...field.iterations].sort((a, b) => Number(a.completed) - Number(b.completed)).map(iteration => ({
					id: iteration.id,
					label: iteration.title,
					detail: localize('kingu.tasks.projects.iterationDetail', "{0} · {1}d", iteration.startDate, iteration.duration),
					group: iteration.completed ? localize('kingu.tasks.projects.completed', "Completed") : localize('kingu.tasks.projects.currentUpcoming', "Current & upcoming"),
				}))
				: [];
		const selectedId = selected?.kind === 'single-select' ? selected.optionId : selected?.kind === 'iteration' ? selected.iterationId : undefined;
		this._popover(cell, (list, close) => {
			let group: string | undefined;
			for (const choice of choices) {
				if (choice.group && choice.group !== group) {
					group = choice.group;
					append(list, $('.kingu-tasks-gh-project-editor-group')).textContent = group;
				}
				const button = this._row(list, choice.id === selectedId);
				if (choice.color) {
					append(button, $('span.kingu-tasks-gh-projects-option-dot')).dataset.color = choice.color.toLowerCase();
				}
				const text = append(button, $('span.kingu-tasks-gh-popover-text'));
				append(text, $('span.truncate')).textContent = choice.label;
				if (choice.detail) {
					append(text, $('span.kingu-tasks-gh-popover-path')).textContent = choice.detail;
				}
				button.addEventListener('click', () => {
					close();
					if (choice.id !== selectedId) {
						void this._setField(row, field, field.kind === 'iteration' ? { kind: 'iteration', iterationId: choice.id } : { kind: 'single-select', optionId: choice.id });
					}
				});
			}
			if (selected) {
				const clear = append(list, $('button.kingu-tasks-gh-popover-row.kingu-tasks-gh-project-editor-clear')) as HTMLButtonElement;
				clear.type = 'button';
				clear.textContent = localize('kingu.tasks.projects.clear', "Clear");
				clear.addEventListener('click', () => {
					close();
					void this._setField(row, field, null);
				});
			}
		});
	}

	private _showInput(cell: HTMLElement, row: IKinguProjectRow, field: IKinguProjectField, kind: 'text' | 'number' | 'date', redraw: () => void): void {
		const current = row.fieldValuesByFieldId[field.id];
		clearNode(cell);
		const input = append(cell, $('input.kingu-tasks-gh-project-editor-input')) as HTMLInputElement;
		input.type = kind;
		input.setAttribute('aria-label', field.name);
		input.value = current?.kind === 'text' ? current.text : current?.kind === 'number' ? String(current.number) : current?.kind === 'date' ? current.date : '';
		let done = false;
		const finish = (commit: boolean) => {
			if (done) {
				return;
			}
			done = true;
			const mutation = commit ? projectInputMutation(kind, input.value, current) : undefined;
			if (mutation === undefined) {
				redraw();
			} else {
				void this._setField(row, field, mutation);
			}
		};
		input.addEventListener('keydown', event => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				finish(true);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(false);
			}
		});
		input.addEventListener('blur', () => finish(true));
		input.focus();
		if (kind !== 'date') {
			input.select();
		}
	}

	// #endregion

	// #region Labels and assignees

	private _showToggles(cell: HTMLElement, row: IKinguProjectRow, kind: 'labels' | 'assignees'): void {
		const repository = projectRowRepository(row);
		if (!repository || row.content.number === null) {
			return;
		}
		const slug = { owner: repository.owner, repo: repository.repo, host: this._host.host() };
		const key = `${kind}:${slug.host ?? ''}:${slug.owner}/${slug.repo}`;
		let candidates = this._candidates.get(key);
		if (!candidates) {
			candidates = kind === 'labels'
				? this._orca.invoke<{ ok: boolean; labels?: string[] }>('gh:listLabelsBySlug', slug).then(result => result?.ok ? result.labels ?? [] : [])
				: this._orca.invoke<{ ok: boolean; users?: { login: string }[] }>('gh:listAssignableUsersBySlug', { ...slug, seedLogins: row.content.assignees.map(user => user.login) }).then(result => result?.ok ? (result.users ?? []).map(user => user.login) : []);
			candidates = candidates.catch(() => [] as string[]);
			this._candidates.set(key, candidates);
		}
		const pending = candidates;
		this._popover(cell, (list, _close, store) => {
			append(list, $('.kingu-tasks-gh-project-editor-group')).textContent = localize('kingu.tasks.projects.loading', "Loading...");
			let disposed = false;
			store.add(toDisposable(() => { disposed = true; }));
			void pending.then(names => {
				if (disposed) {
					return;
				}
				clearNode(list);
				const draw = () => {
					clearNode(list);
					const now = this._host.getRow(row.id) ?? row;
					const chosen = new Set(kind === 'labels' ? now.content.labels.map(label => label.name) : now.content.assignees.map(user => user.login));
					// Values already on the item stay listed even when the repository no longer offers them.
					const all = [...new Set([...chosen, ...names])];
					if (all.length === 0) {
						append(list, $('.kingu-tasks-gh-project-editor-group')).textContent = kind === 'labels'
							? localize('kingu.tasks.projects.noLabels', "No labels in this repo.")
							: localize('kingu.tasks.projects.noAssignees', "No one can be assigned in this repo.");
					}
					for (const name of all) {
						const on = chosen.has(name);
						const button = this._row(list, on);
						append(button, $('span.truncate')).textContent = name;
						button.addEventListener('click', () => {
							void this._toggle(now, kind, name, !on).then(draw);
							draw();
						});
					}
				};
				draw();
			});
		});
	}

	private async _toggle(row: IKinguProjectRow, kind: 'labels' | 'assignees', name: string, add: boolean): Promise<void> {
		const repository = projectRowRepository(row);
		if (!repository || row.content.number === null) {
			return;
		}
		const content = kind === 'labels'
			? { ...row.content, labels: add ? [...row.content.labels, { name, color: '808080' }] : row.content.labels.filter(label => label.name !== name) }
			: { ...row.content, assignees: add ? [...row.content.assignees, { login: name, name: null, avatarUrl: null }] : row.content.assignees.filter(user => user.login !== name) };
		const optimistic = { ...row, content };
		this._host.replaceRow(optimistic);
		const updates = kind === 'labels' ? (add ? { addLabels: [name] } : { removeLabels: [name] }) : (add ? { addAssignees: [name] } : { removeAssignees: [name] });
		const result = await this._mutate(this._orca.invoke<MutationResult>('gh:updateIssueBySlug', { owner: repository.owner, repo: repository.repo, host: this._host.host(), number: row.content.number, updates }));
		if (!result.ok) {
			const now = this._host.getRow(row.id);
			if (now?.content === content) {
				this._host.replaceRow({ ...now, content: row.content });
			}
			this._notificationService.error(result.error?.message || localize('kingu.tasks.projects.toggleFailed', "Could not update {0}.", name));
		}
	}

	// #endregion

	private _row(list: HTMLElement, checked: boolean): HTMLButtonElement {
		const button = append(list, $('button.kingu-tasks-gh-popover-row')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('role', 'option');
		button.setAttribute('aria-selected', String(checked));
		button.appendChild(lucideIcon('check', 12, checked ? 'kingu-tasks-gh-check on' : 'kingu-tasks-gh-check'));
		return button;
	}

	/** A list anchored under the cell, closed by Escape, a click elsewhere, or a choice. */
	private _popover(cell: HTMLElement, fill: (list: HTMLElement, close: () => void, store: DisposableStore) => void): void {
		this._contextViewService.showContextView({
			getAnchor: () => cell,
			render: container => {
				const store = new DisposableStore();
				const popover = append(container, $('.kingu-tasks-gh-popover.kingu-tasks-gh-project-editor'));
				const list = append(popover, $('.kingu-tasks-gh-popover-list'));
				list.setAttribute('role', 'listbox');
				fill(list, () => this._contextViewService.hideContextView(), store);
				store.add(addDisposableListener(popover, EventType.KEY_DOWN, (event: KeyboardEvent) => {
					if (event.key === 'Escape') {
						event.stopPropagation();
						this._contextViewService.hideContextView();
						cell.focus();
					}
				}));
				const buttons = Array.from(list.children).filter((child): child is HTMLElement => isHTMLElement(child) && child.tagName === 'BUTTON');
				(buttons.find(button => button.getAttribute('aria-selected') === 'true') ?? buttons[0])?.focus();
				return store;
			},
		});
	}
}
