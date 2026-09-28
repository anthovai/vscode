/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { lucideIcon, providerIcon } from './kinguOrcaFooterParts.js';

/** What the accounts pane needs from the screen. */
export interface IOrcaAccountsPaneHost {
	invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
	confirm(message: string, detail: string, primaryButton: string): Promise<boolean>;
	notifyError(message: string): void;
	/** Redraws the pane from the state kept here. */
	redraw(): void;
	/** The ADE's rate-limit snapshot, for Grok's usage. */
	rateLimits(): Record<string, unknown> | undefined;
	openExternal(url: string): void;
}

/** `ClaudeRateLimitAccountsState` / `CodexRateLimitAccountsState`, as the pane reads them. */
interface IManagedAccountsState {
	readonly accounts: readonly {
		readonly id: string;
		readonly email: string;
		readonly managedAuthRuntime?: 'host' | 'wsl';
		readonly managedHomeRuntime?: 'host' | 'wsl';
		readonly wslDistro?: string | null;
		readonly organizationName?: string | null;
		readonly workspaceLabel?: string | null;
		readonly lastAuthenticatedAt: number;
	}[];
	readonly activeAccountId: string | null;
	readonly activeAccountIdsByRuntime?: { readonly host: string | null };
	readonly systemDefault?: { readonly authKind: 'oauth' | 'api-key' | 'none'; readonly email: string | null; readonly hasAuth: boolean };
}

interface IGrokStatus {
	readonly signedIn: boolean;
	readonly email: string | null;
	readonly tokenFresh: boolean;
	readonly error: string | null;
}

interface IMiniMaxStatus {
	readonly cookieConfigured?: boolean;
	readonly apiKeyConfigured?: boolean;
}

type Provider = 'claude' | 'codex';

/** `getHostRuntimeLabel`: the host's name in the ADE's sentences. */
function hostLabel(): string {
	return isWindows ? 'Windows' : localize('kingu.accounts.thisDevice', "this device");
}

/** `formatAccountTimestamp`: `Sep 23, 9:41 PM`. */
function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** A `Badge variant="outline"` as the pane uses it: `h-4 rounded px-1.5 text-[10px] font-medium`. */
function badge(parent: HTMLElement, text: string, tone: 'normal' | 'destructive' = 'normal'): void {
	append(parent, $(`span.kingu-orca-account-badge.${tone}`)).textContent = text;
}

/** An `xs` button: `h-6 gap-1 rounded-md px-2 text-xs`, outline or ghost. */
export function smallButton(parent: HTMLElement, variant: 'outline' | 'ghost', icon: string | undefined, label: string, run: () => void, spinning = false): HTMLButtonElement {
	const button = append(parent, $(`button.kingu-orca-xs-button.${variant}`)) as HTMLButtonElement;
	button.type = 'button';
	if (icon) {
		button.appendChild(lucideIcon(spinning ? 'loader-circle' : icon, 12, spinning ? 'spin' : undefined));
	}
	append(button, $('span')).textContent = label;
	button.addEventListener('click', event => {
		event.stopPropagation();
		run();
	});
	return button;
}

/**
 * The ADE's AI Provider Accounts pane, for the sections it draws as its own
 * panels: Claude's and Codex's managed accounts (`accounts-pane-claude-section`,
 * `accounts-pane-codex-section`), MiniMax's stored credentials and Grok's CLI
 * sign-in. The host runtime only; the ADE's WSL account location is not
 * offered here.
 */
export class OrcaAccountsPane {

	private readonly _accounts = new Map<Provider, IManagedAccountsState>();
	private readonly _action = new Map<Provider, string>();
	private _grok: IGrokStatus | undefined;
	private _grokRefreshing = false;
	private _miniMax: IMiniMaxStatus | undefined;
	private readonly _drafts = new Map<string, string>();
	private _loaded = false;

	constructor(private readonly _host: IOrcaAccountsPaneHost) { }

	/** Reads what the pane shows, once per opening. */
	async load(): Promise<void> {
		this._loaded = true;
		await Promise.all([
			this._loadAccounts('claude'),
			this._loadAccounts('codex'),
			this._loadGrok(),
			this._host.invoke<IMiniMaxStatus>('minimaxCredentials:getStatus').then(status => { this._miniMax = status; }, () => undefined),
		]);
		this._host.redraw();
	}

	get loaded(): boolean {
		return this._loaded;
	}

	/** The ADE's host-or-WSL account location; accounts here are the host's, so it is not offered. */
	isHidden(title: string | undefined): boolean {
		return title === 'Account Location';
	}

	/** Draws one of the pane's sections by its title; `false` when it is not one of the ADE's own panels. */
	render(parent: HTMLElement, title: string | undefined, description: string | undefined): boolean {
		switch (title) {
			case 'Claude':
				this._renderProvider(parent, 'claude', description);
				return true;
			case 'Codex':
				this._renderProvider(parent, 'codex', description);
				return true;
			case 'Grok (xAI)':
				this._renderGrok(parent, description);
				return true;
			default:
				return false;
		}
	}

	/** MiniMax's credential rows, which the ADE keeps outside its settings. */
	renderMiniMaxCredential(parent: HTMLElement, label: string): boolean {
		if (label === 'Stored locally / Credentials not set') {
			const status = append(parent, $('.kingu-orca-account-status'));
			status.appendChild(lucideIcon('shield-check', 16, this._miniMaxConfigured() ? '' : 'kingu-orca-muted'));
			const text = append(status, $('.kingu-orca-account-status-text'));
			append(text, $('p.strong')).textContent = this._miniMaxConfigured()
				? localize('kingu.accounts.minimax.stored', "Stored locally")
				: localize('kingu.accounts.minimax.notSet', "Credentials not set");
			append(text, $('p')).textContent = localize('kingu.accounts.minimax.storedDetail', "Stored locally and sent to the selected MiniMax endpoint for usage refreshes.");
			return true;
		}
		if (label === 'MiniMax Session Cookie') {
			this._renderSecret(parent, 'cookie', label,
				localize('kingu.accounts.minimax.cookieDescription', "Paste your MiniMax session cookie for local rate-limit fetching."),
				localize('kingu.accounts.minimax.cookiePlaceholder', "Paste the Cookie header from DevTools"),
				!!this._miniMax?.cookieConfigured, 'minimaxCredentials:saveCookie', 'minimaxCredentials:clearCookie');
			return true;
		}
		if (label === 'MiniMax API key') {
			this._renderSecret(parent, 'apiKey', label,
				localize('kingu.accounts.minimax.keyDescription', "Paste the API key from your MiniMax console → API keys. Stored locally and sent to the selected MiniMax endpoint for usage refreshes. The API key takes priority over the cookie."),
				localize('kingu.accounts.minimax.keyPlaceholder', "Paste your MiniMax API key"),
				!!this._miniMax?.apiKeyConfigured, 'minimaxCredentials:saveApiKey', 'minimaxCredentials:clearApiKey');
			return true;
		}
		return false;
	}

	private _miniMaxConfigured(): boolean {
		return !!(this._miniMax?.cookieConfigured || this._miniMax?.apiKeyConfigured);
	}

	private async _loadAccounts(provider: Provider): Promise<void> {
		try {
			const state = await this._host.invoke<IManagedAccountsState>(`${provider}Accounts:list`);
			if (state) {
				this._accounts.set(provider, state);
			}
		} catch {
			// No managed accounts: the pane shows the system default alone.
		}
	}

	private async _loadGrok(): Promise<void> {
		try {
			this._grok = await this._host.invoke<IGrokStatus>('grokAccounts:getStatus');
		} catch (error) {
			this._grok = { signedIn: false, email: null, tokenFresh: false, error: error instanceof Error ? error.message : 'Unable to read Grok sign-in' };
		}
	}

	/** `runClaudeAccountAction` / `runCodexAccountAction`: one action at a time, the list replaced by what it returns. */
	private async _run(provider: Provider, action: string, operation: () => Promise<IManagedAccountsState | undefined>): Promise<void> {
		if (this._action.has(provider)) {
			return;
		}
		this._action.set(provider, action);
		this._host.redraw();
		try {
			const next = await operation();
			if (next && Array.isArray(next.accounts)) {
				this._accounts.set(provider, next);
			} else {
				await this._loadAccounts(provider);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/cancel/i.test(message)) {
				this._host.notifyError(message);
			}
		} finally {
			this._action.delete(provider);
			this._host.redraw();
		}
	}

	private _renderProvider(parent: HTMLElement, provider: Provider, description: string | undefined): void {
		const name = provider === 'claude' ? 'Claude' : 'Codex';
		const state = this._accounts.get(provider);
		const action = this._action.get(provider);
		const busy = action !== undefined;
		const activeId = state?.activeAccountIdsByRuntime?.host ?? state?.activeAccountId ?? null;
		const where = hostLabel();

		const head = append(parent, $('.kingu-orca-settings-subsection-header'));
		const title = append(head, $('h3.kingu-orca-account-title'));
		title.appendChild(providerIcon(provider, 16));
		title.append(name);
		if (description) {
			append(head, $('p')).textContent = description;
		}

		const block = append(parent, $('.kingu-orca-account-block'));
		const bar = append(block, $('.kingu-orca-account-bar'));
		const text = append(bar, $('.kingu-orca-settings-row-text'));
		append(text, $('label.kingu-orca-settings-label')).textContent = localize('kingu.accounts.accounts', "Accounts");
		append(text, $('p.kingu-orca-settings-description')).textContent = localize('kingu.accounts.showing', "Showing accounts for {0}. New accounts are added there.", where);
		const buttons = append(bar, $('.kingu-orca-account-buttons'));
		const add = smallButton(buttons, 'outline', 'plus', localize('kingu.accounts.add', "Add Account"),
			() => void this._run(provider, 'adding', () => this._host.invoke(`${provider}Accounts:add`, { runtime: 'host', wslDistro: null })), action === 'adding');
		add.disabled = busy;
		if (action === 'adding') {
			smallButton(buttons, 'ghost', 'x', localize('kingu.accounts.cancel', "Cancel"), () => void this._host.invoke(`${provider}Accounts:cancelPendingLogin`).catch(() => undefined));
		}

		const list = append(block, $('.kingu-orca-account-list'));
		const systemActive = activeId === null;
		const systemNeedsSignIn = provider === 'codex' && systemActive && state?.systemDefault !== undefined && !state.systemDefault.hasAuth;
		const system = append(list, $('button.kingu-orca-account-card')) as HTMLButtonElement;
		system.type = 'button';
		system.classList.toggle('active', systemActive);
		system.classList.toggle('destructive', systemNeedsSignIn);
		system.disabled = busy;
		const systemBody = append(system, $('.kingu-orca-account-card-body'));
		const systemLine = append(systemBody, $('.kingu-orca-account-card-line'));
		append(systemLine, $('span.kingu-orca-account-name')).textContent = localize('kingu.accounts.systemDefault', "System default");
		if (systemActive) {
			badge(systemLine, localize('kingu.accounts.active', "Active"));
		}
		if (systemNeedsSignIn) {
			badge(systemLine, localize('kingu.accounts.needsSignIn', "Needs sign-in"), 'destructive');
		}
		const systemIdentity = state?.systemDefault;
		append(systemBody, $(`span.kingu-orca-account-detail${systemNeedsSignIn ? '.destructive' : ''}`)).textContent = systemNeedsSignIn
			? localize('kingu.accounts.codexNoSignIn', "No Codex sign-in was found for {0}.", where)
			: provider === 'codex' && systemIdentity?.authKind === 'oauth' && systemIdentity.email
				? systemIdentity.email
				: provider === 'codex' && systemIdentity?.authKind === 'api-key'
					? localize('kingu.accounts.codexCustomProvider', "Custom provider — no usage tracked.")
					: localize('kingu.accounts.useSystem', "Use your current {0} {1} login.", where, name);
		system.addEventListener('click', () => void this._run(provider, 'select:system', () => this._host.invoke(`${provider}Accounts:select`, { accountId: null })));

		const accounts = (state?.accounts ?? []).filter(account => (account.managedAuthRuntime ?? account.managedHomeRuntime) !== 'wsl');
		if (accounts.length === 0) {
			append(list, $('.kingu-orca-account-empty')).textContent = localize('kingu.accounts.none', "No managed {0} accounts for {1}. Kingu will use that environment's system default {0} login until you add one here.", name, where);
		}
		for (const account of accounts) {
			const active = account.id === activeId;
			const card = append(list, $('.kingu-orca-account-card'));
			card.classList.toggle('active', active);
			const select = append(card, $('button.kingu-orca-account-card-body')) as HTMLButtonElement;
			select.type = 'button';
			select.disabled = busy;
			const line = append(select, $('.kingu-orca-account-card-line'));
			append(line, $('span.kingu-orca-account-name')).textContent = account.email;
			badge(line, where);
			if (active) {
				badge(line, localize('kingu.accounts.active', "Active"));
			}
			const organization = account.organizationName ?? account.workspaceLabel;
			append(select, $('span.kingu-orca-account-detail')).textContent = organization
				? `${organization} · ${formatTimestamp(account.lastAuthenticatedAt)}`
				: formatTimestamp(account.lastAuthenticatedAt);
			select.addEventListener('click', () => void this._run(provider, `select:${account.id}`, () => this._host.invoke(`${provider}Accounts:select`, { accountId: account.id })));

			const actions = append(card, $('.kingu-orca-account-actions'));
			const reauth = smallButton(actions, 'ghost', 'refresh-cw', localize('kingu.accounts.reauth', "Re-authenticate"),
				() => void this._run(provider, `reauth:${account.id}`, () => this._host.invoke(`${provider}Accounts:reauthenticate`, { accountId: account.id })), action === `reauth:${account.id}`);
			reauth.disabled = busy;
			const remove = smallButton(actions, 'ghost', 'trash-2', localize('kingu.accounts.remove', "Remove"), () => void this._remove(provider, account.id));
			remove.classList.add('danger');
			remove.disabled = busy;
		}
	}

	/** The ADE's removal dialogs, with its copy. */
	private async _remove(provider: Provider, accountId: string): Promise<void> {
		const confirmed = provider === 'claude'
			? await this._host.confirm(
				localize('kingu.accounts.removeClaudeTitle', "Remove Claude Account?"),
				localize('kingu.accounts.removeClaudeDetail', "Kingu will delete the managed Claude auth for this saved account. If it is currently active, Kingu falls back to the system default Claude login."),
				localize({ key: 'kingu.accounts.removeConfirm', comment: ['&& denotes a mnemonic'] }, "&&Remove Account"))
			: await this._host.confirm(
				localize('kingu.accounts.removeCodexTitle', "Remove Codex Account?"),
				localize('kingu.accounts.removeCodexDetail', "Removing this account permanently deletes its managed Codex home, including all Codex session history and MCP logins stored inside. This cannot be undone. If the account is currently active, Kingu falls back to the system default Codex login."),
				localize({ key: 'kingu.accounts.removeConfirm', comment: ['&& denotes a mnemonic'] }, "&&Remove Account"));
		if (confirmed) {
			await this._run(provider, `remove:${accountId}`, () => this._host.invoke(`${provider}Accounts:remove`, { accountId }));
		}
	}

	/** `GrokAccountsSection`: the docs link, the sign-in card with "Refresh usage", then the usage. */
	private _renderGrok(parent: HTMLElement, description: string | undefined): void {
		const headRow = append(parent, $('.kingu-orca-account-head-row'));
		const head = append(headRow, $('.kingu-orca-settings-subsection-header'));
		const title = append(head, $('h3.kingu-orca-account-title'));
		title.appendChild(providerIcon('grok', 16));
		title.append('Grok (xAI)');
		if (description) {
			append(head, $('p')).textContent = description;
		}
		const docs = append(headRow, $('button.kingu-orca-account-link')) as HTMLButtonElement;
		docs.type = 'button';
		append(docs, $('span')).textContent = localize('kingu.accounts.grokDocs', "Grok CLI docs");
		docs.appendChild(lucideIcon('external-link', 12));
		docs.addEventListener('click', () => this._host.openExternal('https://docs.x.ai/build/overview'));

		const status = this._grok;
		const fresh = !!status?.signedIn && !!status.tokenFresh;
		const card = append(parent, $('.kingu-orca-account-status'));
		card.classList.toggle('fresh', fresh);
		card.appendChild(lucideIcon('shield-check', 16, fresh ? '' : 'kingu-orca-muted'));
		const text = append(card, $('.kingu-orca-account-status-text'));
		if (!status) {
			append(text, $('p')).textContent = localize('kingu.accounts.loading', "Loading…");
		} else if (status.signedIn) {
			append(text, $('p.strong')).textContent = status.email ?? localize('kingu.accounts.signedIn', "Signed in");
			append(text, $('p')).textContent = status.tokenFresh
				? localize('kingu.accounts.grokFresh', "Signed in. Kingu reads the Grok CLI session stored on disk.")
				: localize('kingu.accounts.grokExpired', "Session expired — run grok on the computer running Kingu and wait for it to start. If prompted, complete sign-in, then click Refresh usage. No chat message is needed.");
		} else {
			append(text, $('p.strong')).textContent = localize('kingu.accounts.grokSignedOut', "Not signed in to Grok CLI");
			append(text, $('p')).textContent = localize('kingu.accounts.grokHow', "In a terminal, run grok login, then click Refresh usage here.");
		}
		if (status?.error) {
			append(text, $('p.destructive')).textContent = status.error;
		}
		smallButton(card, 'outline', 'refresh-cw', localize('kingu.accounts.refreshUsage', "Refresh usage"), () => void this._refreshGrok(), this._grokRefreshing).disabled = this._grokRefreshing;
	}

	private async _refreshGrok(): Promise<void> {
		this._grokRefreshing = true;
		this._host.redraw();
		try {
			await this._host.invoke('rateLimits:refresh');
			await this._loadGrok();
		} finally {
			this._grokRefreshing = false;
			this._host.redraw();
		}
	}

	/** A credential kept in the ADE's own store: a password field with Save, and Forget once one is stored. */
	private _renderSecret(parent: HTMLElement, id: string, label: string, description: string, placeholder: string, stored: boolean, saveChannel: string, clearChannel: string): void {
		const element = append(parent, $('.kingu-orca-settings-stacked'));
		append(element, $('label.kingu-orca-settings-label')).textContent = label;
		append(element, $('p.kingu-orca-settings-description')).textContent = description;
		const line = append(element, $('.kingu-orca-settings-path'));
		const input = append(line, $('input.kingu-orca-input')) as HTMLInputElement;
		input.type = 'password';
		input.autocomplete = 'off';
		input.placeholder = stored ? '••••••••••••' : placeholder;
		input.value = this._drafts.get(id) ?? '';
		input.setAttribute('aria-label', label);
		input.addEventListener('input', () => this._drafts.set(id, input.value));
		const save = append(line, $('button.kingu-orca-button.outline')) as HTMLButtonElement;
		save.type = 'button';
		save.textContent = localize('kingu.accounts.save', "Save");
		save.addEventListener('click', async () => {
			const value = input.value.trim();
			if (!value) {
				return;
			}
			try {
				await this._host.invoke(saveChannel, value);
				this._drafts.delete(id);
				this._miniMax = await this._host.invoke<IMiniMaxStatus>('minimaxCredentials:getStatus');
			} catch (error) {
				this._host.notifyError(error instanceof Error ? error.message : String(error));
			}
			this._host.redraw();
		});
		if (stored) {
			const forget = append(line, $('button.kingu-orca-button.outline')) as HTMLButtonElement;
			forget.type = 'button';
			forget.textContent = id === 'apiKey' ? localize('kingu.accounts.forgetKey', "Forget key") : localize('kingu.accounts.forgetCookie', "Forget cookie");
			forget.addEventListener('click', async () => {
				try {
					await this._host.invoke(clearChannel);
					this._miniMax = await this._host.invoke<IMiniMaxStatus>('minimaxCredentials:getStatus');
				} catch (error) {
					this._host.notifyError(error instanceof Error ? error.message : String(error));
				}
				this._host.redraw();
			});
		}
	}
}
