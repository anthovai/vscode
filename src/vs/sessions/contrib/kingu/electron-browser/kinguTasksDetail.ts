/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksDetail.css';
import { $, addDisposableListener, append, clearNode, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { fromNow } from '../../../../base/common/date.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import {
	getAddCommentRequest,
	getTaskDetailRequests,
	getTaskReference,
	getTaskTitle,
	getTaskUrl,
	IKinguTaskComment,
	IKinguTaskDetail,
	IKinguTaskRef,
	readAddCommentResult,
	readTaskDetail,
} from '../common/kinguTasksDetail.js';
import { getWorkItemStatus } from '../common/kinguTasksGitHub.js';
import { formatGitLabTypeState, getGitLabStateTone } from '../common/kinguTasksGitLab.js';
import { getJiraStatusTone } from '../common/kinguTasksJira.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { openExternalIssue } from './kinguTasksJiraList.js';
import { renderLinearStatePill } from './kinguTasksLinearList.js';

export interface IKinguTasksDetailHost {
	/** Back to the list the task was opened from. */
	back(): void;
	startWorkspace(ref: IKinguTaskRef): void;
}

function providerLabel(ref: IKinguTaskRef): string {
	switch (ref.provider) {
		case 'github': return localize('kingu.tasks.detail.github', "GitHub");
		case 'gitlab': return localize('kingu.tasks.detail.gitlab', "GitLab");
		case 'jira': return localize('kingu.tasks.detail.jira', "Jira");
		case 'linear': return localize('kingu.tasks.detail.linear', "Linear");
	}
}

/**
 * The ADE's task detail (its per-provider item dialogs and drawers), in place
 * of the list: the task's title, state and people, its description and
 * comments, a box to comment, and Start workspace. The list stays behind it,
 * so Back returns to the same query and scroll.
 */
export class KinguTasksDetail extends Disposable {

	readonly element: HTMLElement = $('.kingu-tasks-detail');

	private readonly _rendered = this._register(new DisposableStore());
	private readonly _content: HTMLElement;
	private _detail: IKinguTaskDetail | undefined;
	private _comments: IKinguTaskComment[] = [];
	private _error: string | undefined;
	private _loading = true;
	private _commentDraft = '';
	private _posting = false;
	private _commentError: string | undefined;

	constructor(
		private readonly _ref: IKinguTaskRef,
		private readonly _host: IKinguTasksDetailHost,
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IMarkdownRendererService private readonly _markdownRendererService: IMarkdownRendererService,
	) {
		super();
		this.element.tabIndex = -1;
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const target = event.target;
			// Escape steps back to the list; the page's own Escape would close Tasks.
			if (event.key === 'Escape' && !(isHTMLElement(target) && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'))) {
				event.preventDefault();
				event.stopPropagation();
				this._host.back();
			}
		}));
		this._renderBar(append(this.element, $('.kingu-tasks-detail-bar')));
		this._content = append(this.element, $('.kingu-tasks-detail-scroll'));
		this._render();
		void this._load();
	}

	focus(): void {
		this.element.focus();
	}

	private _button(parent: HTMLElement, icon: string, label: string, className: string, run: () => void, showLabel: boolean): HTMLButtonElement {
		const button = append(parent, $(`button.${className}`)) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(lucideIcon(icon, 14));
		if (showLabel) {
			append(button, $('span')).textContent = label;
		} else {
			this._register(this._hoverService.setupDelayedHover(button, { content: label, position: { hoverPosition: HoverPosition.BELOW } }));
		}
		this._register(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	private _renderBar(bar: HTMLElement): void {
		this._button(bar, 'arrow-left', localize('kingu.tasks.detail.back', "Back to {0} Tasks", providerLabel(this._ref)), 'kingu-tasks-detail-icon', () => this._host.back(), false);
		const reference = append(bar, $('span.kingu-tasks-gh-id.kingu-tasks-detail-reference'));
		append(reference, $('span.kingu-tasks-gh-number')).textContent = getTaskReference(this._ref);
		append(bar, $('span.kingu-tasks-detail-provider')).textContent = providerLabel(this._ref);
		append(bar, $('span.kingu-tasks-detail-spacer'));
		this._button(bar, 'external-link', localize('kingu.tasks.detail.openInBrowser', "Open in {0}", providerLabel(this._ref)), 'kingu-tasks-detail-icon', () => openExternalIssue(this._openerService, getTaskUrl(this._ref)), false);
		this._button(bar, 'play', localize('kingu.tasks.detail.startWorkspace', "Start Workspace"), 'kingu-tasks-detail-start', () => this._host.startWorkspace(this._ref), true);
	}

	private async _load(): Promise<void> {
		const requests = getTaskDetailRequests(this._ref);
		// The issue's own call must answer; a Jira or Linear comment list that fails leaves the issue readable.
		const answers = await Promise.allSettled(requests.map(request => this._orca.invoke<unknown>(request.channel, request.args)));
		if (this._store.isDisposed) {
			return;
		}
		const first = answers[0];
		if (first.status === 'rejected' || first.value === null || first.value === undefined) {
			this._error = first.status === 'rejected'
				? (first.reason instanceof Error ? first.reason.message : String(first.reason))
				: localize('kingu.tasks.detail.notFound', "{0} could not be loaded. It may have been deleted or you may not have access.", getTaskReference(this._ref));
		} else {
			this._detail = readTaskDetail(this._ref, answers.map(answer => answer.status === 'fulfilled' ? answer.value : undefined));
			this._comments = [...this._detail.comments];
		}
		this._loading = false;
		this._render();
	}

	private _render(): void {
		this._rendered.clear();
		const content = this._content;
		clearNode(content);

		append(content, $('h2.kingu-tasks-detail-title')).textContent = getTaskTitle(this._ref);
		const status = append(content, $('.kingu-tasks-detail-status'));
		this._renderState(status);
		const updatedAt = new Date(this._ref.provider === 'github' || this._ref.provider === 'gitlab' ? this._ref.item.updatedAt : this._ref.issue.updatedAt);
		if (!Number.isNaN(updatedAt.getTime())) {
			const updated = append(status, $('span.kingu-tasks-detail-muted'));
			updated.textContent = localize('kingu.tasks.detail.updated', "Updated {0}", fromNow(updatedAt, true, true));
			this._rendered.add(this._hoverService.setupDelayedHover(updated, { content: updatedAt.toLocaleString(), position: { hoverPosition: HoverPosition.BELOW } }));
		}
		const labels = this._ref.provider === 'github' || this._ref.provider === 'gitlab' ? this._ref.item.labels : this._ref.issue.labels;
		if (labels.length > 0) {
			const line = append(content, $('.kingu-tasks-detail-labels'));
			for (const label of labels) {
				append(line, $('span.kingu-tasks-gh-label')).textContent = label;
			}
		}

		if (this._error) {
			append(content, $('.kingu-tasks-credential-error')).textContent = this._error;
			return;
		}
		if (this._loading || !this._detail) {
			const loading = append(content, $('.kingu-tasks-detail-loading'));
			loading.appendChild(lucideIcon('loader-circle', 16, 'kingu-tasks-spin'));
			append(loading, $('span')).textContent = localize('kingu.tasks.detail.loading', "Loading {0}...", getTaskReference(this._ref));
			return;
		}

		if (this._detail.facts.length > 0) {
			const facts = append(content, $('dl.kingu-tasks-detail-facts'));
			for (const fact of this._detail.facts) {
				append(facts, $('dt')).textContent = fact.label;
				append(facts, $('dd')).textContent = fact.value;
			}
		}

		const description = append(content, $('section.kingu-tasks-detail-section'));
		append(description, $('h3.kingu-tasks-detail-heading')).textContent = localize('kingu.tasks.detail.description', "Description");
		if (this._detail.body.trim()) {
			this._markdown(append(description, $('.kingu-tasks-detail-body')), this._detail.body);
		} else {
			append(description, $('p.kingu-tasks-detail-muted')).textContent = localize('kingu.tasks.detail.noDescription', "No description provided.");
		}

		const comments = append(content, $('section.kingu-tasks-detail-section'));
		append(comments, $('h3.kingu-tasks-detail-heading')).textContent = localize('kingu.tasks.detail.comments', "Comments ({0})", this._comments.length);
		if (this._comments.length === 0) {
			append(comments, $('p.kingu-tasks-detail-muted')).textContent = localize('kingu.tasks.detail.noComments', "No comments yet.");
		}
		for (const comment of this._comments) {
			this._renderComment(comments, comment);
		}
		this._renderComposer(comments);
	}

	/** Each provider's own state pill, as its list draws it. */
	private _renderState(parent: HTMLElement): void {
		const ref = this._ref;
		switch (ref.provider) {
			case 'github': {
				const status = getWorkItemStatus(ref.item);
				append(parent, $(`span.kingu-tasks-gh-status.${status.tone}`)).textContent = ref.item.type === 'pr'
					? localize('kingu.tasks.detail.prState', "Pull request · {0}", status.label)
					: localize('kingu.tasks.detail.issueState', "Issue · {0}", status.label);
				return;
			}
			case 'gitlab':
				append(parent, $(`span.kingu-tasks-gh-status.${getGitLabStateTone(ref.item.state)}`)).textContent = formatGitLabTypeState(ref.item);
				return;
			case 'jira':
				append(append(parent, $(`span.kingu-tasks-status.${getJiraStatusTone(ref.issue.status.categoryKey)}`)), $('span')).textContent = ref.issue.status.name;
				return;
			case 'linear':
				parent.appendChild(renderLinearStatePill(ref.issue.state, false));
				return;
		}
	}

	private _markdown(parent: HTMLElement, body: string): void {
		// Provider text is not trusted: no command links, and its HTML is sanitized.
		const rendered = this._markdownRendererService.render(new MarkdownString(body, { isTrusted: false, supportHtml: true }));
		this._rendered.add(rendered);
		parent.appendChild(rendered.element);
	}

	private _renderComment(parent: HTMLElement, comment: IKinguTaskComment): void {
		const card = append(parent, $('article.kingu-tasks-detail-comment'));
		const head = append(card, $('.kingu-tasks-detail-comment-head'));
		if (comment.avatarUrl) {
			const image = append(head, $('img.kingu-tasks-avatar')) as HTMLImageElement;
			image.alt = comment.author;
			image.referrerPolicy = 'no-referrer';
			image.src = comment.avatarUrl;
		} else {
			append(head, $('span.kingu-tasks-avatar.initial')).textContent = comment.author.slice(0, 1).toUpperCase();
		}
		append(head, $('span.kingu-tasks-detail-author')).textContent = comment.author;
		const createdAt = new Date(comment.createdAt);
		if (!Number.isNaN(createdAt.getTime())) {
			const when = append(head, $('span.kingu-tasks-detail-muted'));
			when.textContent = fromNow(createdAt, true, true);
			this._rendered.add(this._hoverService.setupDelayedHover(when, { content: createdAt.toLocaleString(), position: { hoverPosition: HoverPosition.BELOW } }));
		}
		if (comment.path) {
			append(head, $('span.kingu-tasks-detail-path')).textContent = comment.path;
		}
		if (comment.url) {
			const url = comment.url;
			const open = append(head, $('button.kingu-tasks-row-action.kingu-tasks-detail-comment-link')) as HTMLButtonElement;
			open.type = 'button';
			const label = localize('kingu.tasks.detail.openComment', "Open comment in {0}", providerLabel(this._ref));
			open.setAttribute('aria-label', label);
			open.appendChild(lucideIcon('external-link', 12));
			this._rendered.add(this._hoverService.setupDelayedHover(open, { content: label, position: { hoverPosition: HoverPosition.BELOW } }));
			this._rendered.add(addDisposableListener(open, EventType.CLICK, () => openExternalIssue(this._openerService, url)));
		}
		const body = append(card, $('.kingu-tasks-detail-body'));
		if (comment.body.trim()) {
			this._markdown(body, comment.body);
		}
	}

	/** The ADE's comment box: markdown, posted with Ctrl/Cmd+Enter or the button. */
	private _renderComposer(parent: HTMLElement): void {
		const composer = append(parent, $('.kingu-tasks-detail-composer'));
		const input = append(composer, $('textarea.kingu-tasks-detail-input')) as HTMLTextAreaElement;
		input.rows = 3;
		input.placeholder = localize('kingu.tasks.detail.commentPlaceholder', "Leave a comment...");
		input.setAttribute('aria-label', localize('kingu.tasks.detail.commentLabel', "Comment on {0}", getTaskReference(this._ref)));
		input.value = this._commentDraft;
		input.disabled = this._posting;
		const footer = append(composer, $('.kingu-tasks-detail-composer-footer'));
		if (this._commentError) {
			append(footer, $('span.kingu-tasks-detail-error')).textContent = this._commentError;
		}
		append(footer, $('span.kingu-tasks-detail-spacer'));
		const submit = append(footer, $('button.kingu-tasks-detail-start')) as HTMLButtonElement;
		submit.type = 'button';
		if (this._posting) {
			submit.appendChild(lucideIcon('loader-circle', 14, 'kingu-tasks-spin'));
		}
		append(submit, $('span')).textContent = localize('kingu.tasks.detail.comment', "Comment");
		const sync = () => { submit.disabled = this._posting || !input.value.trim(); };
		sync();
		this._rendered.add(addDisposableListener(input, EventType.INPUT, () => {
			this._commentDraft = input.value;
			sync();
		}));
		this._rendered.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				void this._post();
			}
		}));
		this._rendered.add(addDisposableListener(submit, EventType.CLICK, () => void this._post()));
	}

	private async _post(): Promise<void> {
		const body = this._commentDraft.trim();
		if (!body || this._posting) {
			return;
		}
		this._posting = true;
		this._commentError = undefined;
		this._render();
		const request = getAddCommentRequest(this._ref, body);
		let result: ReturnType<typeof readAddCommentResult>;
		try {
			result = readAddCommentResult(await this._orca.invoke<unknown>(request.channel, request.args), body, new Date());
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (this._store.isDisposed) {
			return;
		}
		this._posting = false;
		if (result.ok) {
			this._comments.push(result.comment);
			this._commentDraft = '';
		} else {
			this._commentError = result.error;
		}
		this._render();
	}
}
