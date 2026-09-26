/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { KINGU_AI_SIGN_IN_COMMAND_ID, KINGU_AI_SIGN_IN_IN_TERMINAL_COMMAND_ID } from '../../../../workbench/contrib/kingu/common/kinguAiAccounts.js';
import { formatKinguAiUsage, IKinguAiAccountRow, loadKinguAiAccountRows } from '../common/kinguAiAccountSummary.js';
import { KINGU_PROVIDER_LOGOS } from '../common/kinguProviderLogos.js';
import { logoIcon, lucideIcon } from './kinguOrcaFooterParts.js';
import { badge, smallButton } from './kinguOrcaSettingsAccounts.js';

/**
 * The Signed-in AI section at the top of Settings → AI Provider Accounts, the
 * one place every AI signs in (the account panel only counts them): each AI
 * with who it is signed in as, its plan and what it has used, and Sign In, or
 * Sign In Again to change the account.
 */
export class KinguAiAccountsSection {

	private _rows: IKinguAiAccountRow[] | undefined;
	private _loading = false;

	constructor(
		private readonly _commandService: ICommandService,
		private readonly _redraw: () => void,
	) { }

	async load(): Promise<void> {
		this._loading = true;
		this._rows = await loadKinguAiAccountRows(this._commandService);
		this._loading = false;
		this._redraw();
	}

	render(parent: HTMLElement): void {
		const head = append(parent, $('.kingu-orca-settings-subsection-header'));
		const title = append(head, $('h3.kingu-orca-account-title'));
		title.append(localize('kingu.aiAccounts.title', "Signed-in AI"));
		const refresh = smallButton(title, 'ghost', 'refresh-cw', localize('kingu.aiAccounts.refresh', "Refresh"), () => void this.load(), this._loading);
		refresh.disabled = this._loading;
		append(head, $('p')).textContent = localize('kingu.aiAccounts.description', "Every AI agent on this machine and the account it uses. Sign in here once; each agent then works in any session.");

		const list = append(parent, $('.kingu-orca-account-list'));
		if (!this._rows) {
			append(list, $('p.kingu-orca-settings-description')).textContent = localize('kingu.aiAccounts.loading', "Checking your AI accounts...");
			return;
		}
		if (this._rows.length === 0) {
			append(list, $('p.kingu-orca-settings-description')).textContent = localize('kingu.aiAccounts.empty', "No AI agents were found on this machine.");
			return;
		}
		const now = Date.now();
		for (const row of this._rows) {
			const card = append(list, $('.kingu-orca-account-card.kingu-ai-account-card'));
			const logo = KINGU_PROVIDER_LOGOS[row.id];
			const icon = logo ? logoIcon(logo, 18) : lucideIcon('bot', 18);
			icon.classList.add('kingu-ai-account-icon');
			card.appendChild(icon);
			const body = append(card, $('.kingu-ai-account-body'));
			const line = append(body, $('.kingu-orca-account-card-line'));
			append(line, $('span.kingu-orca-account-name')).textContent = row.label;
			if (row.signedIn) {
				badge(line, row.plan ?? localize('kingu.aiAccounts.signedIn', "Signed in"));
			} else {
				badge(line, localize('kingu.aiAccounts.notSignedIn', "Not signed in"), 'destructive');
			}
			const detail = [row.email, formatKinguAiUsage(row.usage, now)].filter(Boolean).join(' · ');
			if (detail) {
				append(body, $('span.kingu-orca-account-detail')).textContent = detail;
			}
			const actions = append(card, $('.kingu-orca-account-actions'));
			smallButton(actions, row.signedIn ? 'ghost' : 'outline', row.signIn === 'terminal' ? 'square-terminal' : 'circle-user-round',
				row.signedIn ? localize('kingu.aiAccounts.signInAgain', "Sign In Again") : localize('kingu.aiAccounts.signIn', "Sign In"),
				() => void this._signIn(row));
		}
	}

	private async _signIn(row: IKinguAiAccountRow): Promise<void> {
		if (row.signIn === 'terminal') {
			await this._commandService.executeCommand(KINGU_AI_SIGN_IN_IN_TERMINAL_COMMAND_ID, row.id);
		} else {
			await this._commandService.executeCommand(KINGU_AI_SIGN_IN_COMMAND_ID, row.id);
		}
		await this.load();
	}
}
