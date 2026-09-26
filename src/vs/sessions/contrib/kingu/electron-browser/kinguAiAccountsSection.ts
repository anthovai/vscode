/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { KINGU_AI_SIGN_IN_COMMAND_ID, KINGU_AI_SIGN_IN_IN_TERMINAL_COMMAND_ID } from '../../../../workbench/contrib/kingu/common/kinguAiAccounts.js';
import { formatKinguAiUsage, IKinguAiAccountRow, loadKinguAiAccountRows } from '../common/kinguAiAccountSummary.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { smallButton } from './kinguOrcaSettingsAccounts.js';

/**
 * The ADE's accounts pane already has a section for Claude, Codex, Gemini and
 * OpenCode; this is the AI id each of those sections stands for. Claude and
 * Codex sign in through their own account management there.
 */
const SECTION_OF_AI: Readonly<Record<string, string>> = {
	claude: 'Claude',
	codex: 'Codex',
	gemini: 'Gemini',
	opencode: 'OpenCode Go',
};

/**
 * Sign-in status for the AIs on Settings → AI Provider Accounts, added to the
 * pane's own sections rather than beside them: a status card at the top of
 * the Gemini and OpenCode sections (which only hold settings), and one
 * More Agents section, styled like Grok's, for the agents the pane has no
 * section for (Qwen Code and other ACP agents).
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

	/** The status card for the AI a pane section stands for, under its header; nothing for Claude and Codex. */
	renderSectionStatus(parent: HTMLElement, sectionTitle: string | undefined): void {
		const id = Object.keys(SECTION_OF_AI).find(key => SECTION_OF_AI[key] === sectionTitle);
		if (!id || id === 'claude' || id === 'codex') {
			return;
		}
		const row = this._rows?.find(candidate => candidate.id === id);
		if (this._rows && !row) {
			return;
		}
		this._renderStatus(parent, row);
	}

	/** The agents the pane has no section for; `false` when there are none. */
	renderMoreAgents(parent: HTMLElement): boolean {
		const rows = (this._rows ?? []).filter(row => !SECTION_OF_AI[row.id]);
		if (rows.length === 0) {
			return false;
		}
		const head = append(parent, $('.kingu-orca-settings-subsection-header'));
		const title = append(head, $('h3.kingu-orca-account-title'));
		title.appendChild(lucideIcon('bot', 16));
		title.append(localize('kingu.aiAccounts.moreAgents', "More Agents"));
		append(head, $('p')).textContent = localize('kingu.aiAccounts.moreAgentsDescription', "Agent CLIs Kingu found on this machine. Each signs in with its own login, in a terminal.");
		const list = append(parent, $('.kingu-orca-account-list'));
		for (const row of rows) {
			this._renderStatus(list, row);
		}
		return true;
	}

	/** Grok's status card: who it is signed in as and what it has used, or how to sign in. */
	private _renderStatus(parent: HTMLElement, row: IKinguAiAccountRow | undefined): void {
		const card = append(parent, $('.kingu-orca-account-status'));
		card.classList.toggle('fresh', !!row?.signedIn);
		card.appendChild(lucideIcon('shield-check', 16, row?.signedIn ? '' : 'kingu-orca-muted'));
		const text = append(card, $('.kingu-orca-account-status-text'));
		if (!row) {
			append(text, $('p')).textContent = localize('kingu.aiAccounts.loading', "Loading…");
			return;
		}
		if (row.signedIn) {
			append(text, $('p.strong')).textContent = [row.label, row.plan ?? row.email ?? localize('kingu.aiAccounts.signedIn', "Signed in")].join(' · ');
			const usage = formatKinguAiUsage(row.usage, Date.now());
			if (usage) {
				append(text, $('p')).textContent = usage;
			}
		} else {
			append(text, $('p.strong')).textContent = localize('kingu.aiAccounts.notSignedInTo', "Not signed in to {0}", row.label);
			append(text, $('p')).textContent = row.signIn === 'terminal'
				? localize('kingu.aiAccounts.signInTerminalHow', "Sign In opens a terminal running its own login.")
				: localize('kingu.aiAccounts.signInHow', "Sign In runs its login and uses the new account.");
		}
		const button = smallButton(card, row.signedIn ? 'ghost' : 'outline', row.signIn === 'terminal' ? 'square-terminal' : 'circle-user-round',
			row.signedIn ? localize('kingu.aiAccounts.signInAgain', "Sign In Again") : localize('kingu.aiAccounts.signIn', "Sign In"),
			() => void this._signIn(row), this._loading);
		button.disabled = this._loading;
	}

	private async _signIn(row: IKinguAiAccountRow): Promise<void> {
		await this._commandService.executeCommand(row.signIn === 'terminal' ? KINGU_AI_SIGN_IN_IN_TERMINAL_COMMAND_ID : KINGU_AI_SIGN_IN_COMMAND_ID, row.id);
		await this.load();
	}
}
