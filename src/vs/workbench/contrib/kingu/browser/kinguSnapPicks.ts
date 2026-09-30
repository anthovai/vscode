/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry } from '../../../common/views.js';
import { DefaultViewsContext, IExtensionsWorkbenchService, VIEWLET_ID as SNAP_VIEWLET_ID } from '../../extensions/common/extensions.js';
import { IKinguSnapPack, KINGU_SNAP_PACKS, kinguPackProgress, kinguPacksForWorkspace } from '../common/kinguSnapPacks.js';

const KINGU_SNAP_PICKS_VIEW_ID = 'workbench.views.extensions.kinguPicks';
/** Folders under the root looked into for a project's files: a repository often keeps its app one level down. */
const MAX_SUBFOLDERS = 20;

/**
 * Snap's front page, above its lists while nothing is searched: Snap packs,
 * the extensions a kind of work needs, as cards that install together, the
 * ones this workspace's files point to first. VS Code opens on lists of
 * extensions; Snap opens on what you are working on.
 */
class KinguSnapPicksView extends ViewPane {

	private _body: HTMLElement | undefined;
	private readonly _renderDisposables = this._register(new DisposableStore());
	private _forWorkspace: readonly IKinguSnapPack[] = [];
	private readonly _installing = new Set<string>();

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IExtensionsWorkbenchService private readonly _extensions: IExtensionsWorkbenchService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this._extensions.onChange(() => this._render()));
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => this._detect()));
		this._detect();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._body = append(container, $('.kingu-snap'));
		this._render();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._body) {
			this._body.style.height = `${height}px`;
		}
	}

	private async _detect(): Promise<void> {
		const root = this._workspace.getWorkspace().folders[0]?.uri;
		if (!root) {
			this._forWorkspace = [];
			this._render();
			return;
		}
		let subfolders: string[] = [];
		try {
			const stat = await this._fileService.resolve(root);
			subfolders = (stat.children ?? []).filter(child => child.isDirectory && !child.name.startsWith('.') && child.name !== 'node_modules').slice(0, MAX_SUBFOLDERS).map(child => child.name);
		} catch {
			// An unreadable root has no project files to go by.
		}
		const read = async (name: string) => {
			for (const folder of [undefined, ...subfolders]) {
				const uri = folder ? joinPath(root, folder, name) : joinPath(root, name);
				try {
					return (await this._fileService.readFile(uri, { length: 200_000 })).value.toString();
				} catch {
					// Not here; the next folder, then none.
				}
			}
			return undefined;
		};
		this._forWorkspace = await kinguPacksForWorkspace(read);
		this._render();
	}

	private _installedIds(): Set<string> {
		return new Set(this._extensions.local.map(extension => extension.identifier.id.toLowerCase()));
	}

	private _render(): void {
		if (!this._body) {
			return;
		}
		this._renderDisposables.clear();
		clearNode(this._body);
		const installed = this._installedIds();

		// The view's own header names it; the page says what it is for.
		const hero = append(this._body, $('.kingu-snap-hero'));
		append(hero, $('.kingu-snap-hero-subtitle')).textContent = localize('kingu.snap.subtitle', "Everything a kind of work needs, installed in one go.");

		const forWorkspace = new Set(this._forWorkspace.map(pack => pack.id));
		if (this._forWorkspace.length) {
			this._section(localize('kingu.snap.forProject', "For this project"), this._forWorkspace, installed, true);
		}
		this._section(localize('kingu.snap.packs', "Snap packs"), KINGU_SNAP_PACKS.filter(pack => !forWorkspace.has(pack.id)), installed, false);
	}

	private _section(title: string, packs: readonly IKinguSnapPack[], installed: ReadonlySet<string>, recommended: boolean): void {
		append(this._body!, $('.kingu-snap-section-title')).textContent = title;
		const grid = append(this._body!, $('.kingu-snap-grid'));
		for (const pack of packs) {
			this._card(grid, pack, installed, recommended);
		}
	}

	private _card(parent: HTMLElement, pack: IKinguSnapPack, installed: ReadonlySet<string>, recommended: boolean): void {
		const card = append(parent, $('.kingu-snap-card'));
		card.classList.toggle('recommended', recommended);
		const head = append(card, $('.kingu-snap-card-head'));
		append(head, renderIcon(ThemeIcon.fromId(pack.icon))).classList.add('kingu-snap-card-icon');
		append(head, $('.kingu-snap-card-name')).textContent = pack.name;
		append(card, $('.kingu-snap-card-description')).textContent = pack.description;

		const chips = append(card, $('.kingu-snap-card-chips'));
		for (const id of pack.extensions) {
			const has = installed.has(id.toLowerCase());
			const chip = append(chips, $('span.kingu-snap-chip', { role: 'button', tabIndex: 0 }));
			chip.classList.toggle('installed', has);
			if (has) {
				append(chip, renderIcon(Codicon.check));
			}
			append(chip, $('span')).textContent = id.slice(id.indexOf('.') + 1);
			this._renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), chip, localize('kingu.snap.chipHover', "{0} — show details", id)));
			const open = () => this._extensions.open(id);
			this._renderDisposables.add(addDisposableListener(chip, EventType.CLICK, open));
			this._renderDisposables.add(addDisposableListener(chip, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			}));
		}

		const { installed: done, total } = kinguPackProgress(pack, installed);
		const button = append(card, $('button.kingu-snap-card-button')) as HTMLButtonElement;
		const busy = this._installing.has(pack.id);
		button.disabled = busy || done === total;
		button.classList.toggle('done', done === total);
		button.textContent = busy
			? localize('kingu.snap.installing', "Installing…")
			: done === total
				? localize('kingu.snap.installed', "Installed")
				: done > 0
					? localize('kingu.snap.installRest', "Install {0} more", total - done)
					: localize('kingu.snap.installAll', "Install all {0}", total);
		this._renderDisposables.add(addDisposableListener(button, EventType.CLICK, () => this._install(pack)));
	}

	private async _install(pack: IKinguSnapPack): Promise<void> {
		this._installing.add(pack.id);
		this._render();
		const missing = pack.extensions.filter(id => !this._installedIds().has(id.toLowerCase()));
		const failed: string[] = [];
		try {
			const found = await this._extensions.getExtensions(missing.map(id => ({ id })), CancellationToken.None);
			await Promise.all(missing.map(async id => {
				const extension = found.find(candidate => candidate.identifier.id.toLowerCase() === id.toLowerCase());
				try {
					await (extension ? this._extensions.install(extension) : this._extensions.install(id));
				} catch {
					failed.push(id);
				}
			}));
		} finally {
			this._installing.delete(pack.id);
			this._render();
		}
		if (failed.length) {
			this._notificationService.warn(localize('kingu.snap.installFailed', "{0}: these could not be installed: {1}", pack.name, failed.join(', ')));
		}
	}
}

/** Puts the view on Snap's front page, once Snap's container is registered. */
class KinguSnapPicksContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.kinguSnapPicks';

	constructor() {
		const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(SNAP_VIEWLET_ID);
		if (!container) {
			return;
		}
		Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
			id: KINGU_SNAP_PICKS_VIEW_ID,
			name: localize2('kingu.snap.viewName', "Kingu Picks"),
			ctorDescriptor: new SyncDescriptor(KinguSnapPicksView),
			when: ContextKeyExpr.and(DefaultViewsContext),
			weight: 100,
			order: 0,
			canToggleVisibility: true,
		}], container);
	}
}

registerWorkbenchContribution2(KinguSnapPicksContribution.ID, KinguSnapPicksContribution, WorkbenchPhase.BlockStartup);
