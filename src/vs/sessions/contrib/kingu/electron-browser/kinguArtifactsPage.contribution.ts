/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksPage.css';
import './media/kinguArtifacts.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { EditorResourceAccessor } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import {
	artifactContentTypeForFile,
	artifactDisplayTitle,
	artifactExpiryLabel,
	artifactTypeLabel,
	formatArtifactBytes,
	IKinguArtifact,
	IKinguArtifactPage,
	KINGU_ARTIFACTS_VIEW_ID,
	KINGU_SHARE_ARTIFACT_COMMAND_ID,
	KINGU_SHOW_ARTIFACTS_COMMAND_ID,
	KinguRuntimeResponse,
	readArtifactOperation,
} from '../common/kinguArtifacts.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { openExternalIssue } from './kinguTasksJiraList.js';

/** The ADE's `KinguProfileAuthStatus`, the part the page reads. */
interface IAuthStatus {
	readonly state: 'local' | 'unconfigured' | 'connected' | 'reconnect-required';
	readonly cloud?: { readonly email: string };
	readonly setupMessage?: string;
}

type PageState =
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready' }
	| { readonly kind: 'signIn' }
	| { readonly kind: 'unconfigured'; readonly message: string }
	| { readonly kind: 'error'; readonly message: string };

/**
 * The ADE's Artifacts page (`components/artifacts/ArtifactsPage.tsx`,
 * `ArtifactCollection.tsx`, `ArtifactsPageStates.tsx`, `ArtifactActions.tsx`):
 * the pages this account has shared to Kingu's cloud, newest first, each with
 * its link, and a way to stop sharing it. Publishing happens where the file
 * is, through Share as Artifact.
 */
class KinguArtifactsView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('kingu.artifacts.title', "Artifacts"));
	override readonly maxWidth = Number.POSITIVE_INFINITY;
	override readonly showHeader = false;

	private readonly _drawn = this._register(new DisposableStore());
	private _container: HTMLElement | undefined;
	private _state: PageState = { kind: 'loading' };
	private _items: IKinguArtifact[] = [];
	private _nextCursor: string | undefined;
	private _account: string | undefined;
	private _loadingMore = false;
	/** The ADE's device-wide consent (`artifactSharingEnabled`): nothing here may mint a public link until it is on. */
	private _sharingEnabled = false;

	constructor(
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICustomViewService private readonly _customViewService: ICustomViewService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		this._container = container;
		container.classList.add('kingu-tasks-page', 'kingu-artifacts-page');
		this._register(addDisposableListener(container, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				this._customViewService.hideCustomView();
			}
		}));
		this._draw();
		void this._load();
	}

	private async _load(cursor?: string): Promise<void> {
		if (!cursor) {
			this._state = { kind: 'loading' };
			this._draw();
			const [auth, settings] = await Promise.all([
				this._orca.invoke<IAuthStatus>('kinguProfiles:authStatus').catch(() => undefined),
				this._orca.invoke<{ artifactSharingEnabled?: boolean }>('settings:get').catch(() => undefined),
			]);
			this._account = auth?.state === 'connected' ? auth.cloud?.email : undefined;
			this._sharingEnabled = settings?.artifactSharingEnabled === true;
		}
		const outcome = readArtifactOperation(await this._orca.invoke<KinguRuntimeResponse<IKinguArtifactPage>>('runtime:call', { method: 'artifacts.list', params: cursor ? { cursor } : {} }).catch(error => ({ ok: false as const, error: { code: 'invoke_failed', message: error instanceof Error ? error.message : String(error) } })));
		this._loadingMore = false;
		if (outcome.kind === 'ok') {
			this._items = cursor ? [...this._items, ...outcome.value.artifacts] : [...outcome.value.artifacts];
			this._nextCursor = outcome.value.nextCursor;
			this._state = { kind: 'ready' };
		} else {
			this._state = outcome.kind === 'signIn' ? { kind: 'signIn' } : outcome;
		}
		this._draw();
	}

	private async _connect(): Promise<void> {
		try {
			await this._orca.invoke('kinguProfiles:connectCurrent');
		} catch (error) {
			this._notificationService.error(localize('kingu.artifacts.connectFailed', "Could not connect to Kingu cloud: {0}", error instanceof Error ? error.message : String(error)));
		}
		await this._load();
	}

	/** The ADE's Settings → Artifacts switch; turning it on is the user's call, so it asks first. */
	private async _setSharing(enabled: boolean): Promise<void> {
		if (enabled) {
			const { confirmed } = await this._dialogService.confirm({
				message: localize('kingu.artifacts.allowConfirm', "Allow publishing public artifact links on this device?"),
				detail: localize('kingu.artifacts.allowDetail', "Anything running here, agents and the kingu CLI included, will be able to share Markdown and HTML pages as links anyone can open. You can turn this off again at any time."),
				primaryButton: localize('kingu.artifacts.allowButton', "&&Allow Publishing"),
			});
			if (!confirmed) {
				return;
			}
		}
		try {
			await this._orca.invoke('settings:set', { artifactSharingEnabled: enabled });
			this._sharingEnabled = enabled;
		} catch (error) {
			this._notificationService.error(localize('kingu.artifacts.allowFailed', "Could not change the publishing setting: {0}", error instanceof Error ? error.message : String(error)));
		}
		this._draw();
	}

	private async _delete(item: IKinguArtifact): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			type: Severity.Warning,
			message: localize('kingu.artifacts.deleteConfirm', "Stop sharing \"{0}\"?", artifactDisplayTitle(item)),
			detail: localize('kingu.artifacts.deleteDetail', "The link stops working for everyone who has it. This cannot be undone."),
			primaryButton: localize('kingu.artifacts.deleteButton', "&&Stop Sharing"),
		});
		if (!confirmed) {
			return;
		}
		const outcome = readArtifactOperation(await this._orca.invoke<KinguRuntimeResponse<void>>('runtime:call', { method: 'artifacts.delete', params: { id: item.artifact.slug } }).catch(() => undefined));
		if (outcome.kind === 'ok') {
			this._items = this._items.filter(candidate => candidate.artifact.slug !== item.artifact.slug);
			this._draw();
		} else {
			this._notificationService.error(outcome.kind === 'error' || outcome.kind === 'unconfigured' ? outcome.message : localize('kingu.artifacts.signInAgain', "Connect to Kingu cloud again."));
		}
	}

	private _draw(): void {
		const container = this._container;
		if (!container) {
			return;
		}
		this._drawn.clear();
		clearNode(container);

		const bar = append(container, $('.kingu-tasks-source-bar'));
		const sources = append(bar, $('.kingu-tasks-sources'));
		const close = append(sources, $('button.kingu-tasks-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('kingu.artifacts.close', "Close artifacts"));
		close.appendChild(lucideIcon('x', 16));
		this._drawn.add(addDisposableListener(close, EventType.CLICK, () => this._customViewService.hideCustomView()));
		append(sources, $('.kingu-tasks-divider'));
		append(sources, $('h2.kingu-artifacts-heading')).textContent = localize('kingu.artifacts.title', "Artifacts");
		const chip = append(sources, $('.kingu-tasks-summary'));
		append(chip, $('span')).textContent = this._account ?? localize('kingu.artifacts.notConnected', "Not connected");
		const refresh = append(sources, $('button.kingu-tasks-close.kingu-tasks-refresh')) as HTMLButtonElement;
		refresh.type = 'button';
		refresh.setAttribute('aria-label', localize('kingu.artifacts.refresh', "Refresh artifacts"));
		refresh.appendChild(lucideIcon('refresh-cw', 14, this._state.kind === 'loading' ? 'kingu-tasks-spin' : undefined));
		this._drawn.add(this._hoverService.setupDelayedHover(refresh, { content: localize('kingu.artifacts.refresh', "Refresh artifacts"), position: { hoverPosition: HoverPosition.BELOW } }));
		this._drawn.add(addDisposableListener(refresh, EventType.CLICK, () => void this._load()));

		if (this._state.kind === 'ready') {
			const controls = append(bar, $('.kingu-tasks-source-controls'));
			const toggle = append(controls, $('button.kingu-tasks-button.outline.kingu-artifacts-sharing')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.setAttribute('role', 'switch');
			toggle.setAttribute('aria-checked', String(this._sharingEnabled));
			toggle.textContent = this._sharingEnabled
				? localize('kingu.artifacts.sharingOn', "Publishing: On")
				: localize('kingu.artifacts.sharingOff', "Allow Publishing Links");
			this._drawn.add(this._hoverService.setupDelayedHover(toggle, {
				content: this._sharingEnabled
					? localize('kingu.artifacts.sharingOnHint', "Agents, the kingu CLI and Share as Artifact can publish public links from this device. Click to turn it off.")
					: localize('kingu.artifacts.sharingOffHint', "Nothing on this device can publish public artifact links until you allow it."),
				position: { hoverPosition: HoverPosition.BELOW },
			}));
			this._drawn.add(addDisposableListener(toggle, EventType.CLICK, () => void this._setSharing(!this._sharingEnabled)));
		}

		const content = append(container, $('.kingu-tasks-content'));
		switch (this._state.kind) {
			case 'loading': {
				const loading = append(content, $('.kingu-tasks-loading'));
				loading.appendChild(lucideIcon('loader-circle', 20, 'kingu-tasks-spin'));
				return;
			}
			case 'signIn': {
				const card = this._card(content, localize('kingu.artifacts.connectTitle', "Connect to Kingu cloud"), localize('kingu.artifacts.connectDescription', "Sign in to share Markdown and HTML pages as links, and to see the ones you have shared."));
				const actions = append(card, $('.kingu-tasks-card-actions'));
				const connect = append(actions, $('button.kingu-tasks-button.outline')) as HTMLButtonElement;
				connect.type = 'button';
				connect.textContent = localize('kingu.artifacts.connect', "Connect");
				this._drawn.add(addDisposableListener(connect, EventType.CLICK, () => void this._connect()));
				return;
			}
			case 'unconfigured':
				this._card(content, localize('kingu.artifacts.unconfiguredTitle', "Kingu cloud is not set up"), this._state.message);
				return;
			case 'error':
				this._card(content, localize('kingu.artifacts.errorTitle', "Could not load artifacts"), this._state.message);
				return;
		}
		if (this._items.length === 0) {
			this._card(content, localize('kingu.artifacts.emptyTitle', "No shared artifacts yet"), localize('kingu.artifacts.emptyDescription', "Open a Markdown or HTML file and run Share as Artifact to get a link anyone can open."));
			return;
		}
		this._drawTable(content);
	}

	private _card(content: HTMLElement, title: string, description: string): HTMLElement {
		const card = append(content, $('.kingu-tasks-card'));
		const icon = lucideIcon('globe', 32);
		icon.classList.add('kingu-tasks-card-icon');
		card.appendChild(icon);
		append(card, $('p.kingu-tasks-card-title')).textContent = title;
		append(card, $('p.kingu-tasks-card-description')).textContent = description;
		return card;
	}

	private _drawTable(content: HTMLElement): void {
		const now = new Date();
		const table = append(content, $('.kingu-artifacts-table'));
		const header = append(table, $('.kingu-artifacts-row.header'));
		for (const column of [localize('kingu.artifacts.colTitle', "Title"), localize('kingu.artifacts.colType', "Type"), localize('kingu.artifacts.colSize', "Size"), localize('kingu.artifacts.colUpdated', "Updated"), localize('kingu.artifacts.colExpires', "Link"), '']) {
			append(header, $('span')).textContent = column;
		}
		for (const item of this._items) {
			const row = append(table, $('.kingu-artifacts-row'));
			const titleCell = append(row, $('.kingu-artifacts-title'));
			append(titleCell, $('span.truncate')).textContent = artifactDisplayTitle(item);
			if (item.artifact.originalFileName && item.artifact.title) {
				append(titleCell, $('span.kingu-artifacts-file')).textContent = item.artifact.originalFileName;
			}
			append(row, $('span.muted')).textContent = artifactTypeLabel(item.artifact.sourceContentType);
			append(row, $('span.muted')).textContent = formatArtifactBytes(item.artifact.byteSize);
			const updated = append(row, $('span.muted'));
			updated.textContent = fromNow(new Date(item.artifact.updatedAt), true);
			append(row, $('span.muted')).textContent = artifactExpiryLabel(item.artifact.expiresAt, now);
			const actions = append(row, $('.kingu-artifacts-actions'));
			this._action(actions, 'external-link', localize('kingu.artifacts.open', "Open Link"), () => openExternalIssue(this._openerService, item.shareUrl));
			this._action(actions, 'copy', localize('kingu.artifacts.copy', "Copy Link"), () => {
				void this._clipboardService.writeText(item.shareUrl);
				this._notificationService.info(localize('kingu.artifacts.copied', "Copied the link to {0}.", artifactDisplayTitle(item)));
			});
			this._action(actions, 'trash-2', localize('kingu.artifacts.delete', "Stop Sharing"), () => void this._delete(item));
		}
		if (this._nextCursor) {
			const more = append(content, $('button.kingu-tasks-button.outline.kingu-artifacts-more')) as HTMLButtonElement;
			more.type = 'button';
			more.disabled = this._loadingMore;
			more.textContent = localize('kingu.artifacts.loadMore', "Load More");
			this._drawn.add(addDisposableListener(more, EventType.CLICK, () => {
				this._loadingMore = true;
				more.disabled = true;
				void this._load(this._nextCursor);
			}));
		}
	}

	private _action(parent: HTMLElement, icon: string, label: string, run: () => void): void {
		const button = append(parent, $('button.kingu-tasks-row-action')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(lucideIcon(icon, 14));
		this._drawn.add(this._hoverService.setupDelayedHover(button, { content: label, position: { hoverPosition: HoverPosition.BELOW } }));
		this._drawn.add(addDisposableListener(button, EventType.CLICK, run));
	}

	layout(_width: number, height: number): void {
		if (this._container) {
			this._container.style.height = `${height}px`;
		}
	}
}

class KinguArtifactsPageContribution extends Disposable {

	static readonly ID = 'kingu.contrib.artifactsPage';

	constructor(@ICustomViewService customViewService: ICustomViewService) {
		super();
		this._register(customViewService.registerCustomView({ id: KINGU_ARTIFACTS_VIEW_ID, ctor: new SyncDescriptor(KinguArtifactsView) }));
	}
}

registerWorkbenchContribution2(KinguArtifactsPageContribution.ID, KinguArtifactsPageContribution, WorkbenchPhase.BlockRestore);

registerAction2(class ShowKinguArtifactsAction extends Action2 {
	constructor() {
		super({ id: KINGU_SHOW_ARTIFACTS_COMMAND_ID, title: localize2('kingu.showArtifacts', "Kingu: Artifacts"), category: Categories.View, f1: true });
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(KINGU_ARTIFACTS_VIEW_ID);
	}
});

/**
 * The ADE's `ArtifactPublishButton`: shares the open Markdown or HTML file as a
 * page, or updates the page it was shared as before (the ADE keys that on the
 * file's source key), and hands back the link.
 */
registerAction2(class ShareKinguArtifactAction extends Action2 {
	constructor() {
		super({ id: KINGU_SHARE_ARTIFACT_COMMAND_ID, title: localize2('kingu.shareArtifact', "Kingu: Share as Artifact"), f1: true });
	}
	async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const fileService = accessor.get(IFileService);
		const orca = accessor.get(IKinguOrcaService);
		const clipboardService = accessor.get(IClipboardService);
		const openerService = accessor.get(IOpenerService);
		const customViewService = accessor.get(ICustomViewService);
		const target = URI.isUri(resource) ? resource : EditorResourceAccessor.getOriginalUri(accessor.get(IEditorService).activeEditor);
		const fileName = target ? basename(target) : '';
		const contentType = artifactContentTypeForFile(fileName);
		if (!target || !contentType) {
			notificationService.info(localize('kingu.shareArtifact.pickFile', "Open a Markdown or HTML file to share it as an artifact."));
			return;
		}
		let content: string;
		try {
			content = (await fileService.readFile(target)).value.toString();
		} catch (error) {
			notificationService.error(localize('kingu.shareArtifact.readFailed', "Could not read {0}: {1}", fileName, error instanceof Error ? error.message : String(error)));
			return;
		}
		if (!content.trim()) {
			notificationService.info(localize('kingu.shareArtifact.empty', "{0} is empty, so there is nothing to share.", fileName));
			return;
		}
		const outcome = readArtifactOperation(await orca.invoke<KinguRuntimeResponse<{ change: 'created' | 'updated'; item: IKinguArtifact }>>('runtime:call', {
			method: 'artifacts.publish',
			params: { sourceKey: target.toString(), content, contentType, fileName },
		}).catch(error => ({ ok: false as const, error: { code: 'invoke_failed', message: error instanceof Error ? error.message : String(error) } })));
		switch (outcome.kind) {
			case 'ok': {
				const url = outcome.value.item.shareUrl;
				await clipboardService.writeText(url);
				notificationService.prompt(Severity.Info,
					outcome.value.change === 'created'
						? localize('kingu.shareArtifact.created', "Shared {0}. The link is copied.", fileName)
						: localize('kingu.shareArtifact.updated', "Updated the shared page for {0}. The link is copied.", fileName),
					[
						{ label: localize('kingu.shareArtifact.open', "Open Link"), run: () => openExternalIssue(openerService, url) },
						{ label: localize('kingu.shareArtifact.all', "All Artifacts"), run: () => customViewService.showCustomView(KINGU_ARTIFACTS_VIEW_ID) },
					]);
				return;
			}
			case 'signIn':
				notificationService.prompt(Severity.Info, localize('kingu.shareArtifact.signIn', "Connect to Kingu cloud to share artifacts."), [
					{ label: localize('kingu.shareArtifact.connect', "Connect"), run: () => customViewService.showCustomView(KINGU_ARTIFACTS_VIEW_ID) },
				]);
				return;
			default:
				if (/artifact_sharing_disabled|Publishing artifacts is off/.test(outcome.message)) {
					notificationService.prompt(Severity.Info, localize('kingu.shareArtifact.disabled', "Publishing artifact links is off on this device. Allow it on the Artifacts page first."), [
						{ label: localize('kingu.shareArtifact.openArtifacts', "Open Artifacts"), run: () => customViewService.showCustomView(KINGU_ARTIFACTS_VIEW_ID) },
					]);
					return;
				}
				notificationService.error(outcome.message);
		}
	}
});
