/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';
import { AgentSessionStatus, IAgentSession } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { KINGU_CHAT_TABS_SETTING, kinguChatTabsAfterClose, kinguChatTabsWith } from '../common/kinguChatTabs.js';

/** The chat view the tabs switch. */
export interface IKinguChatTabsHost {
	loadSession(resource: URI): Promise<unknown>;
	newChat(): void;
}

/** The chat the view shows, as far as the tabs need it. */
export interface IKinguChatTabsModel {
	readonly sessionResource: URI;
	readonly title: string | undefined;
}

const TABS_STORAGE_KEY = 'kingu.chat.tabs';

/**
 * The chat view's header as a row of agent tabs, one per chat the user has
 * open, like the editor's tabs: status, title, and a close button, and the
 * agent's name on the open one (the others name it on hover, so a narrow view
 * still shows titles). A new chat is the view's own `+`. It takes the place of the header's single title (and of
 * a sessions list above the chat, which showed the open chat twice), so every
 * chat is in one place only. A chat an agent is working on, or that waits for
 * the user, gets a tab of its own even when it was started elsewhere.
 */
export class KinguChatTabs extends Disposable {

	readonly element: HTMLElement = $('div.kingu-chat-tabs', { role: 'tablist' });

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the row gains or loses tabs, so the header shows or hides. */
	readonly onDidChange = this._onDidChange.event;

	private _tabs: URI[];
	private _active: IKinguChatTabsModel | undefined;
	/** Busy chats the user closed: not reopened while they stay busy. */
	private readonly _dismissed = new ResourceSet();
	private readonly _renderDisposables = this._register(new DisposableStore());

	constructor(
		private readonly _host: IKinguChatTabsHost,
		@IAgentSessionsService private readonly _agentSessionsService: IAgentSessionsService,
		@IStorageService private readonly _storageService: IStorageService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._tabs = this._readTabs();
		this._register(this._agentSessionsService.model.onDidChangeSessions(() => this._update()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(KINGU_CHAT_TABS_SETTING)) {
				this._render();
				this._onDidChange.fire();
			}
		}));
		this._render();
	}

	/** Whether the tabs take the header's place (`kingu.chat.tabs`). */
	get enabled(): boolean {
		return this._configurationService.getValue<boolean>(KINGU_CHAT_TABS_SETTING) !== false;
	}

	/** Whether there is a tab to show; an empty row hides the header. */
	get hasTabs(): boolean {
		return this.enabled && this._tabs.length > 0;
	}

	/** The chat the view now shows; a chat with a title (one that has begun) gets a tab. */
	setActive(model: IKinguChatTabsModel | undefined): void {
		this._active = model;
		if (model?.title) {
			this._setTabs(kinguChatTabsWith(this._tabs, [model.sessionResource]));
		}
		this._render();
	}

	private _update(): void {
		// A chat an agent is working on, or waiting in, is open work: it gets a tab.
		const busy = this._agentSessionsService.model.sessions
			.filter(session => !session.isArchived() && (session.status === AgentSessionStatus.InProgress || session.status === AgentSessionStatus.NeedsInput))
			.map(session => session.resource);
		for (const resource of [...this._dismissed]) {
			if (!busy.some(candidate => isEqual(candidate, resource))) {
				this._dismissed.delete(resource);
			}
		}
		this._setTabs(kinguChatTabsWith(this._tabs, busy.filter(resource => !this._dismissed.has(resource))));
		this._render();
	}

	private _setTabs(tabs: URI[]): void {
		const hadTabs = this._tabs.length > 0;
		const changed = tabs.length !== this._tabs.length || tabs.some((tab, index) => !isEqual(tab, this._tabs[index]));
		this._tabs = tabs;
		if (changed) {
			this._storageService.store(TABS_STORAGE_KEY, JSON.stringify(tabs.map(tab => tab.toString())), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		if (hadTabs !== tabs.length > 0) {
			this._onDidChange.fire();
		}
	}

	private _readTabs(): URI[] {
		try {
			const raw = JSON.parse(this._storageService.get(TABS_STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
			return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string').map(value => URI.parse(value)) : [];
		} catch {
			return [];
		}
	}

	private _close(resource: URI): void {
		this._dismissed.add(resource);
		const { tabs, next } = kinguChatTabsAfterClose(this._tabs, resource, this._active?.sessionResource);
		this._setTabs(tabs);
		this._render();
		if (isEqual(resource, this._active?.sessionResource)) {
			if (next) {
				this._host.loadSession(next);
			} else {
				this._host.newChat();
			}
		}
	}

	private _render(): void {
		this._renderDisposables.clear();
		clearNode(this.element);
		if (!this.enabled) {
			return;
		}
		const hover = getDefaultHoverDelegate('mouse');
		let activeTab: HTMLElement | undefined;
		for (const resource of this._tabs) {
			const session = this._agentSessionsService.model.getSession(resource);
			const active = isEqual(resource, this._active?.sessionResource);
			const title = session?.label || (active ? this._active?.title : undefined) || localize('kingu.chatTabs.untitled', "Chat");
			const tab = append(this.element, $('div.kingu-chat-tab', { role: 'tab', tabIndex: 0, 'aria-selected': String(active) }));
			tab.classList.toggle('active', active);
			if (active) {
				activeTab = tab;
			}
			const status = statusOf(session);
			if (status) {
				append(tab, renderIcon(status.icon)).classList.add('kingu-chat-tab-status', status.className);
			}
			if (active && session?.providerLabel) {
				append(tab, $('span.kingu-chat-tab-agent')).textContent = session.providerLabel;
			}
			append(tab, $('span.kingu-chat-tab-title')).textContent = title;
			const close = append(tab, $('span.kingu-chat-tab-close', { role: 'button', 'aria-label': localize('kingu.chatTabs.close', "Close {0}", title) }));
			append(close, renderIcon(Codicon.close));

			const named = session?.providerLabel ? localize('kingu.chatTabs.hoverAgent', "{0} · {1}", session.providerLabel, title) : title;
			this._renderDisposables.add(this._hoverService.setupManagedHover(hover, tab, status
				? localize('kingu.chatTabs.hoverStatus', "{0} — {1}", named, status.label)
				: named));
			this._renderDisposables.add(addDisposableListener(tab, EventType.CLICK, e => {
				e.stopPropagation();
				if (!active) {
					this._host.loadSession(resource);
				}
			}));
			this._renderDisposables.add(addDisposableListener(tab, EventType.AUXCLICK, (e: MouseEvent) => {
				if (e.button === 1) {
					e.stopPropagation();
					this._close(resource);
				}
			}));
			this._renderDisposables.add(addDisposableListener(tab, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					e.stopPropagation();
					this._host.loadSession(resource);
				} else if (e.key === 'Delete') {
					e.preventDefault();
					e.stopPropagation();
					this._close(resource);
				}
			}));
			this._renderDisposables.add(addDisposableListener(close, EventType.CLICK, e => {
				e.stopPropagation();
				this._close(resource);
			}));
		}
		activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}
}

/** The mark before a tab's title: working, waiting for the user, or finished but unread. */
function statusOf(session: IAgentSession | undefined): { icon: ThemeIcon; className: string; label: string } | undefined {
	if (!session) {
		return undefined;
	}
	switch (session.status) {
		case AgentSessionStatus.InProgress:
			return { icon: ThemeIcon.modify(Codicon.loading, 'spin'), className: 'working', label: localize('kingu.chatTabs.working', "working") };
		case AgentSessionStatus.NeedsInput:
			return { icon: Codicon.report, className: 'waiting', label: localize('kingu.chatTabs.waiting', "waiting for you") };
		case AgentSessionStatus.Failed:
			return { icon: Codicon.error, className: 'failed', label: localize('kingu.chatTabs.failed', "failed") };
	}
	return session.isRead() ? undefined : { icon: Codicon.circleFilled, className: 'unread', label: localize('kingu.chatTabs.unread', "unread") };
}
