/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { getRepoGitHubSlug, IKinguGitHubSlug, IKinguRepo } from '../common/kinguTasksGitHub.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { openExternalIssue } from './kinguTasksJiraList.js';

interface IAssignableUser {
	readonly login: string;
	readonly name?: string | null;
	readonly avatarUrl?: string;
}

/** The ADE's `GitHubCreateIssueResult`. */
type CreateIssueResult = { readonly ok: true; readonly number: number; readonly url: string; readonly bodySaveWarning?: string } | { readonly ok: false; readonly error?: string };

interface IDraft {
	repoId: string;
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}

/**
 * The ADE's New GitHub issue dialog (`task-page/github/IssueDialog.tsx`,
 * `IssueSelectors.tsx`, `use-task-page-github-issue-creation.ts`): the target
 * project when several are picked, a title, a markdown description, labels and
 * assignees, filed through `gh:createIssue`. The typed draft survives closing.
 */
export class KinguTasksGitHubIssueDialog extends Disposable {

	private readonly _open = this._register(new MutableDisposable<DisposableStore>());
	private _draft: IDraft | undefined;

	constructor(
		private readonly _host: {
			readonly container: HTMLElement;
			selectedRepos(): readonly IKinguRepo[];
			sourceOf(repo: IKinguRepo): IKinguGitHubSlug | undefined;
			created(): void;
		},
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
	}

	/** The ADE's `resolveNewIssueOpenSeed`: a draft for a still-picked project comes back whole; otherwise only its text does. */
	show(): void {
		const repos = this._host.selectedRepos();
		if (repos.length === 0) {
			return;
		}
		const draft = this._draft;
		const hasContent = !!draft && (!!draft.title.trim() || !!draft.body.trim() || draft.labels.length > 0 || draft.assignees.length > 0);
		const draftRepoPicked = hasContent && repos.some(repo => repo.id === draft?.repoId);
		const state: IDraft = hasContent && draft
			? draftRepoPicked ? { ...draft, labels: [...draft.labels], assignees: [...draft.assignees] } : { repoId: repos[0].id, title: draft.title, body: draft.body, labels: [], assignees: [] }
			: { repoId: repos[0].id, title: '', body: '', labels: [], assignees: [] };
		this._render(state, repos);
	}

	private _render(state: IDraft, repos: readonly IKinguRepo[]): void {
		const store = new DisposableStore();
		this._open.value = store;
		let submitting = false;
		const saveDraft = () => { this._draft = { ...state }; };
		store.add({ dispose: saveDraft });

		const overlay = append(this._host.container, $('.kingu-tasks-gh-dialog-overlay'));
		store.add({ dispose: () => overlay.remove() });
		const dialog = append(overlay, $('.kingu-tasks-gh-dialog'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		const titleId = `kingu-tasks-gh-dialog-title-${Date.now()}`;
		dialog.setAttribute('aria-labelledby', titleId);

		const header = append(dialog, $('.kingu-tasks-gh-dialog-header'));
		const heading = append(header, $('h2.kingu-tasks-gh-dialog-title'));
		heading.id = titleId;
		heading.textContent = localize('kingu.tasks.github.newIssue', "New GitHub issue");
		const description = append(header, $('p.kingu-tasks-gh-dialog-description'));
		const close = append(header, $('button.kingu-tasks-gh-dialog-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('kingu.tasks.github.close', "Close"));
		close.appendChild(lucideIcon('x', 16));

		const body = append(dialog, $('.kingu-tasks-gh-dialog-body'));
		const target = () => repos.find(repo => repo.id === state.repoId) ?? repos[0];
		const syncDescription = () => {
			const repo = target();
			const source = this._host.sourceOf(repo) ?? getRepoGitHubSlug(repo);
			description.textContent = localize('kingu.tasks.github.filingIn', "Filing in {0}", source ? `${source.owner}/${source.repo}` : repo.displayName || localize('kingu.tasks.github.thisRepo', "this repository"));
		};
		syncDescription();

		const field = (label: string) => {
			const wrap = append(body, $('label.kingu-tasks-gh-dialog-field'));
			append(wrap, $('span.kingu-tasks-gh-dialog-label')).textContent = label;
			return wrap;
		};

		const selectors = $('.kingu-tasks-gh-dialog-selectors');
		const labelsControl = this._multiSelect<string>(selectors, store, {
			label: localize('kingu.tasks.github.labels', "Labels"),
			none: localize('kingu.tasks.github.none', "None"),
			empty: localize('kingu.tasks.github.noLabelsDialog', "No labels."),
			selected: () => state.labels,
			key: label => label,
			render: (parent, label) => { append(parent, $('span.truncate')).textContent = label; },
			chip: label => label,
			set: next => { state.labels = next; saveDraft(); },
		});
		const assigneesControl = this._multiSelect<IAssignableUser>(selectors, store, {
			label: localize('kingu.tasks.github.assignees', "Assignees"),
			none: localize('kingu.tasks.github.unassigned', "Unassigned"),
			empty: localize('kingu.tasks.github.noAssignable', "No assignable users."),
			selected: () => state.assignees,
			key: user => user.login,
			render: (parent, user) => {
				const text = append(parent, $('span.kingu-tasks-gh-filter-option-text'));
				append(text, $('b.truncate')).textContent = user.login;
				if (user.name) {
					append(text, $('span.kingu-tasks-gh-filter-option-secondary')).textContent = user.name;
				}
			},
			chip: login => login,
			set: next => { state.assignees = next; saveDraft(); },
		});
		const loadMetadata = () => {
			const repo = target();
			labelsControl.load(this._orca.invoke<string[]>('gh:listLabels', { repoPath: repo.path, repoId: repo.id }));
			assigneesControl.load(this._orca.invoke<IAssignableUser[]>('gh:listAssignableUsers', { repoPath: repo.path, repoId: repo.id }));
		};

		if (repos.length > 1) {
			const select = append(field(localize('kingu.tasks.github.project', "Project")), $('select.kingu-tasks-gh-dialog-select')) as HTMLSelectElement;
			for (const repo of repos) {
				const option = append(select, $('option')) as HTMLOptionElement;
				option.value = repo.id;
				option.textContent = repo.displayName;
				option.selected = repo.id === state.repoId;
			}
			store.add(addDisposableListener(select, EventType.CHANGE, () => {
				state.repoId = select.value;
				// Labels and people belong to the repo they were picked from.
				state.labels = [];
				state.assignees = [];
				saveDraft();
				syncDescription();
				loadMetadata();
			}));
		}

		const title = append(field(localize('kingu.tasks.github.title', "Title")), $('input.kingu-tasks-gh-dialog-input')) as HTMLInputElement;
		title.type = 'text';
		title.placeholder = localize('kingu.tasks.github.titlePlaceholder', "Short summary");
		title.value = state.title;
		const bodyInput = append(field(localize('kingu.tasks.github.descriptionField', "Description (optional, markdown)")), $('textarea.kingu-tasks-gh-dialog-textarea')) as HTMLTextAreaElement;
		bodyInput.placeholder = localize('kingu.tasks.github.bodyPlaceholder', "What's going on?");
		bodyInput.value = state.body;
		body.appendChild(selectors);
		append(body, $('p.kingu-tasks-gh-dialog-hint')).textContent = localize('kingu.tasks.github.submitHint', "{0} to submit.", isMacintosh ? '⌘↩' : 'Ctrl+Enter');

		const footer = append(dialog, $('.kingu-tasks-gh-dialog-footer'));
		const cancel = append(footer, $('button.kingu-tasks-button.outline')) as HTMLButtonElement;
		cancel.type = 'button';
		cancel.textContent = localize('kingu.tasks.github.cancel', "Cancel");
		const submit = append(footer, $('button.kingu-tasks-button.primary')) as HTMLButtonElement;
		submit.type = 'button';

		const sync = () => {
			submit.disabled = submitting || !state.title.trim();
			clearNode(submit);
			if (submitting) {
				submit.appendChild(lucideIcon('loader-circle', 14, 'kingu-tasks-spin'));
			}
			append(submit, $('span')).textContent = submitting ? localize('kingu.tasks.github.creating', "Creating…") : localize('kingu.tasks.github.createIssue', "Create issue");
			for (const control of [title, bodyInput, cancel, close]) {
				control.disabled = submitting;
			}
			labelsControl.setDisabled(submitting);
			assigneesControl.setDisabled(submitting);
		};

		const dismiss = () => {
			if (!submitting) {
				this._open.clear();
			}
		};
		const create = async () => {
			if (submitting || !state.title.trim()) {
				return;
			}
			const repo = target();
			submitting = true;
			sync();
			try {
				const result = await this._orca.invoke<CreateIssueResult>('gh:createIssue', {
					repoPath: repo.path,
					repoId: repo.id,
					title: state.title.trim(),
					body: state.body,
					labels: state.labels,
					assignees: state.assignees,
				});
				if (!result?.ok) {
					this._notificationService.error(result?.error || localize('kingu.tasks.github.createFailed', "Failed to create issue."));
					return;
				}
				submitting = false;
				// Closing saves the draft; then a full success clears it, and a body that failed to save keeps it.
				this._open.clear();
				this._draft = result.bodySaveWarning ? { ...state, title: '' } : undefined;
				this._notificationService.notify({
					severity: result.bodySaveWarning ? Severity.Warning : Severity.Info,
					message: result.bodySaveWarning
						? localize('kingu.tasks.github.openedWithWarning', "Opened issue #{0}. {1}", result.number, result.bodySaveWarning)
						: localize('kingu.tasks.github.opened', "Opened issue #{0}", result.number),
					actions: { primary: [new Action('kingu.tasks.github.viewIssue', localize('kingu.tasks.github.view', "View"), undefined, true, async () => openExternalIssue(this._openerService, result.url))] },
				});
				this._host.created();
			} catch (error) {
				this._notificationService.error(error instanceof Error && error.message ? error.message : localize('kingu.tasks.github.createFailed', "Failed to create issue."));
			} finally {
				if (submitting) {
					submitting = false;
					sync();
				}
			}
		};

		store.add(addDisposableListener(title, EventType.INPUT, () => { state.title = title.value; saveDraft(); sync(); }));
		store.add(addDisposableListener(bodyInput, EventType.INPUT, () => { state.body = bodyInput.value; saveDraft(); }));
		store.add(addDisposableListener(title, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault();
				void create();
			}
		}));
		store.add(addDisposableListener(dialog, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && (isMacintosh ? event.metaKey : event.ctrlKey)) {
				event.preventDefault();
				void create();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				dismiss();
			}
		}));
		store.add(addDisposableListener(overlay, EventType.MOUSE_DOWN, (event: MouseEvent) => {
			if (event.target === overlay) {
				dismiss();
			}
		}));
		store.add(addDisposableListener(cancel, EventType.CLICK, dismiss));
		store.add(addDisposableListener(close, EventType.CLICK, dismiss));
		store.add(addDisposableListener(submit, EventType.CLICK, () => void create()));

		sync();
		loadMetadata();
		title.focus();
	}

	/** `IssueSelectors`: a trigger showing the picks, opening a checkbox list. */
	private _multiSelect<T>(parent: HTMLElement, store: DisposableStore, options: {
		label: string;
		none: string;
		empty: string;
		selected(): readonly string[];
		key(item: T): string;
		render(parent: HTMLElement, item: T): void;
		chip(key: string): string;
		set(next: string[]): void;
	}): { load(items: Promise<readonly T[]>): void; setDisabled(disabled: boolean): void } {
		const wrap = append(parent, $('.kingu-tasks-gh-dialog-field'));
		append(wrap, $('span.kingu-tasks-gh-dialog-label')).textContent = options.label;
		const anchor = append(wrap, $('.kingu-tasks-gh-dialog-multi'));
		const trigger = append(anchor, $('button.kingu-tasks-gh-dialog-multi-trigger')) as HTMLButtonElement;
		trigger.type = 'button';
		trigger.setAttribute('aria-haspopup', 'listbox');
		let items: readonly T[] | undefined;
		let error: string | undefined;
		let loading = false;
		const popover = store.add(new MutableDisposable<DisposableStore>());
		const drawTrigger = () => {
			clearNode(trigger);
			const selected = options.selected();
			if (selected.length === 0) {
				append(trigger, $('span.muted')).textContent = options.none;
			}
			for (const key of selected) {
				append(trigger, $('span.kingu-tasks-gh-dialog-chip')).textContent = options.chip(key);
			}
			if (loading) {
				trigger.appendChild(lucideIcon('loader-circle', 12, 'kingu-tasks-spin'));
			}
		};
		const drawList = (list: HTMLElement, listStore: DisposableStore) => {
			clearNode(list);
			if (error) {
				append(list, $('.kingu-tasks-gh-dialog-error')).textContent = error;
				return;
			}
			if (!items) {
				append(list, $('.kingu-tasks-gh-filter-status')).textContent = localize('kingu.tasks.github.loading', "Loading…");
				return;
			}
			if (items.length === 0) {
				append(list, $('.kingu-tasks-gh-filter-status')).textContent = options.empty;
				return;
			}
			const selected = new Set(options.selected().map(key => key.toLowerCase()));
			for (const item of items) {
				const key = options.key(item);
				const checked = selected.has(key.toLowerCase());
				const row = append(list, $('button.kingu-tasks-gh-dialog-option')) as HTMLButtonElement;
				row.type = 'button';
				row.setAttribute('role', 'option');
				row.setAttribute('aria-selected', String(checked));
				const box = append(row, $('span.kingu-tasks-gh-dialog-check'));
				box.classList.toggle('checked', checked);
				if (checked) {
					box.appendChild(lucideIcon('check', 10));
				}
				options.render(row, item);
				listStore.add(addDisposableListener(row, EventType.CLICK, () => {
					const current = options.selected();
					options.set(checked ? current.filter(value => value.toLowerCase() !== key.toLowerCase()) : [...current, key]);
					drawTrigger();
					drawList(list, listStore);
				}));
			}
		};
		store.add(addDisposableListener(trigger, EventType.CLICK, () => {
			if (popover.value) {
				popover.clear();
				return;
			}
			const listStore = new DisposableStore();
			popover.value = listStore;
			const list = append(anchor, $('.kingu-tasks-gh-dialog-multi-list'));
			list.setAttribute('role', 'listbox');
			listStore.add({ dispose: () => list.remove() });
			drawList(list, listStore);
			listStore.add(addDisposableListener(getWindow(anchor).document, EventType.MOUSE_DOWN, (event: MouseEvent) => {
				if (!anchor.contains(event.target as Node)) {
					popover.clear();
				}
			}, true));
		}));
		drawTrigger();
		return {
			load: request => {
				items = undefined;
				error = undefined;
				loading = true;
				popover.clear();
				drawTrigger();
				request.then(value => { items = value ?? []; }, (err: unknown) => {
					items = [];
					error = err instanceof Error && err.message ? err.message : options.label === localize('kingu.tasks.github.labels', "Labels")
						? localize('kingu.tasks.github.labelsFailed', "Failed to load labels")
						: localize('kingu.tasks.github.usersFailed', "Failed to load assignees");
				}).finally(() => {
					loading = false;
					if (!store.isDisposed) {
						drawTrigger();
					}
				});
			},
			setDisabled: disabled => { trigger.disabled = disabled; },
		};
	}
}
