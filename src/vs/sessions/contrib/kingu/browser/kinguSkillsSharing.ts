/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKinguSkill } from '../common/kinguSkills.js';
import {
	derivedBundleName,
	IKinguOwnedSkillShare,
	IKinguSkillInstallResult,
	IKinguSkillSharePreview,
	IKinguSkillSharingService,
	IKinguSkillVersion,
	isValidBundleName,
	KinguSkillOutcome,
	parseSkillShareId,
	sameSkillFile,
	skillErrorMessage,
	skillsOfVersion,
} from '../common/kinguSkillSharing.js';

/** Where the ADE does not run: nothing to share through, so the Skills page only reads. */
export class UnavailableKinguSkillSharingService implements IKinguSkillSharingService {
	declare readonly _serviceBrand: undefined;
	readonly available = false;
	private _unavailable(): never {
		throw new Error(localize('kingu.skills.unavailable', "Sharing skills needs Kingu's desktop app."));
	}
	discover(): Promise<never> { return this._unavailable(); }
	prepare(): Promise<never> { return this._unavailable(); }
	cancel(): Promise<never> { return this._unavailable(); }
	publish(): Promise<never> { return this._unavailable(); }
	listOwnedShares(): Promise<never> { return this._unavailable(); }
	revoke(): Promise<never> { return this._unavailable(); }
	resolve(): Promise<never> { return this._unavailable(); }
	install(): Promise<never> { return this._unavailable(); }
	connect(): Promise<never> { return this._unavailable(); }
}

/** The ADE shares skills installed in a home folder or a workspace, never bundled or plugin ones. */
export function isKinguSkillShareable(skill: IKinguSkill): boolean {
	return skill.sourceKind === 'home' || skill.sourceKind === 'repo';
}

type ShareStep =
	| { readonly kind: 'idle' }
	| { readonly kind: 'preparing' }
	| { readonly kind: 'review'; readonly preview: IKinguSkillSharePreview }
	| { readonly kind: 'publishing'; readonly preview: IKinguSkillSharePreview }
	| { readonly kind: 'done'; readonly name: string; readonly url: string };

type InstallStep =
	| { readonly kind: 'enter' }
	| { readonly kind: 'resolving' }
	| { readonly kind: 'resolved'; readonly shareId: string; readonly version: IKinguSkillVersion }
	| { readonly kind: 'installing'; readonly shareId: string; readonly version: IKinguSkillVersion }
	| { readonly kind: 'installed'; readonly version: IKinguSkillVersion; readonly result: IKinguSkillInstallResult };

/**
 * The ADE's skill sharing flows (`SkillShareDialog.tsx`, `SkillSharedLinksView.tsx`,
 * `SkillInstallDialog.tsx`), drawn into the Skills page: review and publish
 * the selected skills behind one unlisted link, the links this account has
 * shared, and installing from a link someone sent.
 */
export class KinguSkillsSharingUi extends Disposable {

	private _share: ShareStep = { kind: 'idle' };
	private _bundleName = '';
	private _bundleNameEdited = false;
	private _releaseNotes = '';

	private _links: KinguSkillOutcome<readonly IKinguOwnedSkillShare[]> | undefined;

	private _installLink = '';
	private _install: InstallStep = { kind: 'enter' };
	private _installError: string | undefined;
	private readonly _installSelected = new Set<string>();

	constructor(
		private readonly _sharing: IKinguSkillSharingService,
		private readonly _redraw: () => void,
		/** Called once skills land, so the page scans again and shows them. */
		private readonly _onInstalled: () => void,
		@IDialogService private readonly _dialogService: IDialogService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
	}

	/** Whether a share is under way, so the page shows it instead of the list. */
	get sharing(): boolean {
		return this._share.kind !== 'idle';
	}

	// #region Share

	/** The link name for a selection, until the user types their own. */
	suggestName(selected: readonly IKinguSkill[]): void {
		if (!this._bundleNameEdited) {
			this._bundleName = derivedBundleName(selected);
		}
	}

	/** The selection bar under the list: how many, the link name, and Review. */
	drawSelectionBar(parent: HTMLElement, selected: readonly IKinguSkill[], onCancel: () => void): void {
		const bar = append(parent, $('.kingu-skills-share-bar'));
		append(bar, $('span.kingu-skills-share-count')).textContent = selected.length === 1
			? localize('kingu.skills.share.oneSelected', "1 skill selected")
			: localize('kingu.skills.share.selected', "{0} skills selected", selected.length);
		const field = append(bar, $('label.kingu-skills-share-field'));
		append(field, $('span')).textContent = localize('kingu.skills.share.linkName', "Link name");
		const name = append(field, $('input.kingu-skills-search.kingu-skills-share-name')) as HTMLInputElement;
		name.value = this._bundleName;
		name.placeholder = 'my-skills';
		this._button(bar, localize('kingu.skills.share.cancel', "Cancel"), onCancel);
		const review = this._button(bar, localize('kingu.skills.share.review', "Review…"), () => void this._prepare(selected), true);
		const update = () => {
			const valid = selected.length > 0 && isValidBundleName(this._bundleName);
			review.disabled = !valid;
			name.classList.toggle('invalid', this._bundleName !== '' && !isValidBundleName(this._bundleName));
		};
		name.addEventListener('input', () => {
			this._bundleName = name.value.trim();
			this._bundleNameEdited = true;
			update();
		});
		update();
	}

	private async _prepare(selected: readonly IKinguSkill[]): Promise<void> {
		this._share = { kind: 'preparing' };
		this._redraw();
		try {
			// The page reads skill directories itself; the ADE names them its own way, so match by the SKILL.md file.
			const discovered = await this._sharing.discover();
			const ids = selected.map(skill => discovered.find(candidate => sameSkillFile(candidate.skillFilePath, skill.resource.fsPath))?.id);
			if (ids.some(id => !id)) {
				throw new Error('skill-share-source-not-found');
			}
			const preview = await this._sharing.prepare(ids as string[], this._bundleName);
			this._share = { kind: 'review', preview };
		} catch (error) {
			this._share = { kind: 'idle' };
			this._notificationService.error(localize('kingu.skills.share.prepareFailed', "Could not prepare the skills for sharing: {0}", skillErrorMessage(error)));
		}
		this._redraw();
	}

	drawShare(parent: HTMLElement, onDone: () => void): void {
		const step = this._share;
		switch (step.kind) {
			case 'idle':
				return;
			case 'preparing':
			case 'publishing':
				append(parent, $('.kingu-skills-status')).textContent = step.kind === 'preparing'
					? localize('kingu.skills.share.preparing', "Packing and checking the skills…")
					: localize('kingu.skills.share.publishing', "Uploading and publishing…");
				return;
			case 'done': {
				const done = append(parent, $('.kingu-skills-share-panel'));
				append(done, $('h2.kingu-skills-detail-name')).textContent = localize('kingu.skills.share.doneTitle', "\"{0}\" is shared", step.name);
				append(done, $('p')).textContent = localize('kingu.skills.share.doneDescription', "The link is copied. Anyone who has it can install these skills without signing in.");
				append(done, $('code.kingu-skills-share-link')).textContent = step.url;
				const actions = append(done, $('.kingu-skills-share-actions'));
				this._button(actions, localize('kingu.skills.share.copy', "Copy Link"), () => this._copy(step.url, step.name));
				this._button(actions, localize('kingu.skills.share.back', "Back to Skills"), () => {
					this._share = { kind: 'idle' };
					onDone();
				}, true);
				return;
			}
			case 'review':
				this._drawReview(parent, step.preview);
		}
	}

	private _drawReview(parent: HTMLElement, preview: IKinguSkillSharePreview): void {
		const panel = append(parent, $('.kingu-skills-share-panel'));
		append(panel, $('h2.kingu-skills-detail-name')).textContent = preview.name;
		const count = preview.skillCount ?? preview.skills?.length ?? 1;
		const kilobytes = Math.max(1, Math.round(preview.compressedBytes / 1024));
		append(panel, $('p.kingu-skills-share-muted')).textContent = count === 1
			? localize('kingu.skills.share.summaryOne', "1 skill · {0} files · {1} KB to upload", preview.fileCount, kilobytes)
			: localize('kingu.skills.share.summary', "{0} skills · {1} files · {2} KB to upload", count, preview.fileCount, kilobytes);
		const risky = [...new Set([...preview.scriptPaths, ...preview.executablePaths])];
		if (risky.length > 0) {
			const warning = append(panel, $('.kingu-skills-sources-warning.kingu-skills-share-warning'));
			append(warning, $('p')).textContent = localize('kingu.skills.share.scripts', "These skills include scripts or executables. People who install them can run these files, so check they hold no secrets or machine-specific settings:");
			const list = append(warning, $('ul'));
			for (const path of risky.slice(0, 12)) {
				append(list, $('li')).textContent = path;
			}
			if (risky.length > 12) {
				append(list, $('li')).textContent = localize('kingu.skills.share.morePaths', "and {0} more", risky.length - 12);
			}
		}
		if (preview.skills?.length) {
			const list = append(panel, $('ul.kingu-skills-share-list'));
			for (const skill of preview.skills) {
				append(list, $('li')).textContent = localize('kingu.skills.share.included', "{0} ({1} files)", skill.name, skill.fileCount);
			}
		}
		const field = append(panel, $('label.kingu-skills-share-field.stacked'));
		append(field, $('span')).textContent = localize('kingu.skills.share.notes', "Release notes (optional)");
		const notes = append(field, $('textarea.kingu-skills-search')) as HTMLTextAreaElement;
		notes.rows = 3;
		notes.value = this._releaseNotes;
		notes.addEventListener('input', () => { this._releaseNotes = notes.value; });
		const actions = append(panel, $('.kingu-skills-share-actions'));
		this._button(actions, localize('kingu.skills.share.backToPick', "Back"), () => {
			this._share = { kind: 'idle' };
			void this._sharing.cancel(preview.preparationId);
			this._redraw();
		});
		this._button(actions, localize('kingu.skills.share.publish', "Publish Link"), () => void this._publish(preview), true);
	}

	private async _publish(preview: IKinguSkillSharePreview): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			message: localize('kingu.skills.share.confirm', "Publish \"{0}\" behind an unlisted link?", preview.name),
			detail: localize('kingu.skills.share.confirmDetail', "Anyone with the link can inspect and install these skills without signing in, scripts included. You can unshare the link later, but copies already installed stay installed."),
			primaryButton: localize('kingu.skills.share.confirmButton', "&&Publish"),
		});
		if (!confirmed) {
			return;
		}
		this._share = { kind: 'publishing', preview };
		this._redraw();
		const outcome = await this._sharing.publish(preview.preparationId, this._releaseNotes);
		if (outcome.kind === 'ok') {
			await this._clipboardService.writeText(outcome.value.url);
			this._share = { kind: 'done', name: preview.name, url: outcome.value.url };
			this._bundleNameEdited = false;
			this._releaseNotes = '';
			this._links = undefined;
		} else {
			this._share = { kind: 'review', preview };
			if (outcome.kind === 'signIn') {
				this._notificationService.prompt(Severity.Info, localize('kingu.skills.share.signIn', "Connect to Kingu cloud to share skills."), [
					{ label: localize('kingu.skills.connect', "Connect"), run: () => void this._connect() },
				]);
			} else {
				this._notificationService.error(localize('kingu.skills.share.failed', "Could not publish the skills: {0}", outcome.message));
			}
		}
		this._redraw();
	}

	// #endregion

	// #region Shared links

	drawLinks(parent: HTMLElement): void {
		const links = this._links;
		if (!links) {
			append(parent, $('.kingu-skills-status')).textContent = localize('kingu.skills.links.loading', "Loading your links…");
			void this._loadLinks();
			return;
		}
		switch (links.kind) {
			case 'signIn': {
				const panel = append(parent, $('.kingu-skills-share-panel'));
				append(panel, $('p')).textContent = localize('kingu.skills.links.signIn', "Connect to Kingu cloud to see and manage the links you have shared. People you send a link to do not need an account.");
				this._button(append(panel, $('.kingu-skills-share-actions')), localize('kingu.skills.connect', "Connect"), () => void this._connect(), true);
				return;
			}
			case 'unconfigured':
			case 'error':
				append(parent, $('.kingu-skills-status')).textContent = links.message;
				return;
		}
		if (links.value.length === 0) {
			append(parent, $('.kingu-skills-status')).textContent = localize('kingu.skills.links.none', "No shared links yet. Select skills under Installed and choose Share.");
			return;
		}
		const list = append(parent, $('.kingu-skills-share-links'));
		for (const share of links.value) {
			const row = append(list, $('.kingu-skills-share-link-row'));
			const text = append(row, $('.kingu-skills-share-link-text'));
			append(text, $('.kingu-skills-row-name')).textContent = share.name;
			append(text, $('.kingu-skills-row-description')).textContent = localize('kingu.skills.links.shared', "Shared {0} · {1}", fromNow(new Date(share.createdAt), true), share.url);
			const actions = append(row, $('.kingu-skills-share-actions'));
			this._button(actions, localize('kingu.skills.links.open', "Open"), () => void this._openerService.open(URI.parse(share.url), { openExternal: true }));
			this._button(actions, localize('kingu.skills.links.copy', "Copy"), () => this._copy(share.url, share.name));
			this._button(actions, localize('kingu.skills.links.unshare', "Unshare"), () => void this._revoke(share));
		}
	}

	refreshLinks(): void {
		this._links = undefined;
		this._redraw();
	}

	private async _loadLinks(): Promise<void> {
		this._links = await this._sharing.listOwnedShares();
		this._redraw();
	}

	private async _revoke(share: IKinguOwnedSkillShare): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			type: Severity.Warning,
			message: localize('kingu.skills.links.revokeConfirm', "Unshare \"{0}\"?", share.name),
			detail: localize('kingu.skills.links.revokeDetail', "The link stops working for everyone who has it. Skills already installed from it stay installed."),
			primaryButton: localize('kingu.skills.links.revokeButton', "&&Unshare"),
		});
		if (!confirmed) {
			return;
		}
		const outcome = await this._sharing.revoke(share.id);
		if (outcome.kind !== 'ok') {
			this._notificationService.error(outcome.kind === 'signIn' ? localize('kingu.skills.signInAgain', "Connect to Kingu cloud again.") : outcome.message);
		}
		this.refreshLinks();
	}

	private async _connect(): Promise<void> {
		try {
			await this._sharing.connect();
		} catch (error) {
			this._notificationService.error(localize('kingu.skills.connectFailed', "Could not connect to Kingu cloud: {0}", skillErrorMessage(error)));
		}
		this.refreshLinks();
	}

	// #endregion

	// #region Install from a link

	/** Opens Install from Link on this link, looking it up at once when there is one. */
	setInstallLink(link: string): void {
		this._installLink = link;
		this._install = { kind: 'enter' };
		this._installError = undefined;
		if (link.trim()) {
			void this._resolve();
		}
	}

	private async _resolve(): Promise<void> {
		const shareId = parseSkillShareId(this._installLink);
		if (!shareId) {
			this._installError = localize('kingu.skills.install.invalid', "Paste a Kingu skill link, such as https://kingu.anthovai.com/skills/share/…");
			this._redraw();
			return;
		}
		this._install = { kind: 'resolving' };
		this._installError = undefined;
		this._redraw();
		const outcome = await this._sharing.resolve(shareId);
		if (outcome.kind === 'ok') {
			this._install = { kind: 'resolved', shareId, version: outcome.value };
			this._installSelected.clear();
			for (const skill of skillsOfVersion(outcome.value)) {
				this._installSelected.add(skill.id);
			}
		} else {
			this._install = { kind: 'enter' };
			this._installError = outcome.kind === 'signIn' ? localize('kingu.skills.signInAgain', "Connect to Kingu cloud again.") : outcome.message;
		}
		this._redraw();
	}

	private async _installVersion(shareId: string, version: IKinguSkillVersion): Promise<void> {
		this._install = { kind: 'installing', shareId, version };
		this._redraw();
		const outcome = await this._sharing.install(shareId, version, [...this._installSelected]);
		if (outcome.kind === 'ok') {
			this._install = { kind: 'installed', version, result: outcome.value };
			this._onInstalled();
		} else {
			this._install = { kind: 'resolved', shareId, version };
			this._notificationService.error(localize('kingu.skills.install.failed', "Could not install the skills: {0}", outcome.kind === 'signIn' ? localize('kingu.skills.signInAgain', "Connect to Kingu cloud again.") : outcome.message));
		}
		this._redraw();
	}

	drawInstall(parent: HTMLElement): void {
		const step = this._install;
		if (step.kind === 'installed') {
			const panel = append(parent, $('.kingu-skills-share-panel'));
			const failed = step.result.skills?.some(skill => skill.status === 'failed' || skill.status === 'cancelled');
			append(panel, $('h2.kingu-skills-detail-name')).textContent = failed
				? localize('kingu.skills.install.partly', "Installed \"{0}\" with problems", step.version.name)
				: localize('kingu.skills.install.done', "Installed \"{0}\"", step.version.name);
			append(panel, $('p')).textContent = localize('kingu.skills.install.where', "The skills are in your home folder for every agent Kingu found, and listed under Installed.");
			const list = append(panel, $('ul.kingu-skills-share-list'));
			for (const skill of step.result.skills ?? []) {
				append(list, $('li')).textContent = localize('kingu.skills.install.skill', "{0}: {1}", skill.name, skill.status);
			}
			this._button(append(panel, $('.kingu-skills-share-actions')), localize('kingu.skills.install.another', "Install Another Link"), () => {
				this.setInstallLink('');
				this._redraw();
			});
			return;
		}

		const bar = append(parent, $('.kingu-skills-filters'));
		const input = append(bar, $('input.kingu-skills-search.kingu-skills-share-grow')) as HTMLInputElement;
		input.placeholder = localize('kingu.skills.install.placeholder', "Paste a skill link");
		input.value = this._installLink;
		input.disabled = step.kind === 'resolving' || step.kind === 'installing';
		const lookUp = this._button(bar, localize('kingu.skills.install.lookUp', "Look Up"), () => void this._resolve(), true);
		lookUp.disabled = input.disabled || !this._installLink.trim();
		input.addEventListener('input', () => {
			this._installLink = input.value;
			lookUp.disabled = !input.value.trim();
		});
		input.addEventListener('keydown', event => {
			if (event.key === 'Enter' && input.value.trim()) {
				void this._resolve();
			}
		});
		if (this._installError) {
			append(parent, $('.kingu-skills-sources-warning')).textContent = this._installError;
		}
		if (step.kind === 'resolving') {
			append(parent, $('.kingu-skills-status')).textContent = localize('kingu.skills.install.resolving', "Looking up the link…");
			return;
		}
		if (step.kind === 'enter') {
			append(parent, $('.kingu-skills-status')).textContent = localize('kingu.skills.install.hint', "Links are unlisted: only people who were sent one can install from it. You do not need to sign in.");
			return;
		}
		const panel = append(parent, $('.kingu-skills-share-panel'));
		append(panel, $('h2.kingu-skills-detail-name')).textContent = step.version.name;
		if (step.version.description) {
			append(panel, $('p.kingu-skills-share-muted')).textContent = step.version.description;
		}
		const skills = skillsOfVersion(step.version);
		const list = append(panel, $('.kingu-skills-share-checks'));
		// Built first so the checkboxes can enable it; placed after the list.
		const actions = $('.kingu-skills-share-actions');
		const install = this._button(actions, step.kind === 'installing' ? localize('kingu.skills.install.installing', "Installing…") : localize('kingu.skills.install.install', "Install"), () => void this._installVersion(step.shareId, step.version), true);
		install.disabled = step.kind === 'installing' || this._installSelected.size === 0;
		for (const skill of skills) {
			const row = append(list, $('label.kingu-skills-share-check'));
			const check = append(row, $('input')) as HTMLInputElement;
			check.type = 'checkbox';
			check.checked = this._installSelected.has(skill.id);
			check.disabled = skills.length === 1 || step.kind === 'installing';
			const text = append(row, $('div'));
			append(text, $('.kingu-skills-row-name')).textContent = skill.name;
			if (skill.description) {
				append(text, $('.kingu-skills-row-description')).textContent = skill.description;
			}
			check.addEventListener('change', () => {
				if (check.checked) {
					this._installSelected.add(skill.id);
				} else {
					this._installSelected.delete(skill.id);
				}
				install.disabled = this._installSelected.size === 0;
			});
		}
		append(panel, $('p.kingu-skills-share-muted')).textContent = localize('kingu.skills.install.target', "Installs into your home folder for every agent Kingu found on this machine.");
		panel.appendChild(actions);
	}

	// #endregion

	private _copy(url: string, name: string): void {
		void this._clipboardService.writeText(url);
		this._notificationService.info(localize('kingu.skills.copied', "Copied the link to {0}.", name));
	}

	private _button(parent: HTMLElement, label: string, run: () => void, primary = false): HTMLButtonElement {
		const button = append(parent, $(primary ? 'button.kingu-skills-refresh.kingu-skills-share-primary' : 'button.kingu-skills-refresh')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', run);
		return button;
	}
}
