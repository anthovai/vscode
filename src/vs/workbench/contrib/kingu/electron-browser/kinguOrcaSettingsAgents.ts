/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { agentAvailabilityUpdate } from '../common/kinguOrcaSettings.js';
import { IKinguTuiAgent, KINGU_TUI_AGENTS } from '../common/kinguTuiAgents.js';
import { smallButton } from './kinguOrcaSettingsAccounts.js';
import { providerIcon } from './kinguOrcaFooterParts.js';

/** What the agents list needs from the settings screen. */
export interface IOrcaAgentsListHost {
	invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
	value(key: string): unknown;
	update(values: Record<string, unknown>): Promise<void>;
	openExternal(url: string): void;
	/** Redraws the pane from the state kept here. */
	redraw(): void;
}

/**
 * The lists of the ADE's Agents pane: the agents installed on this machine
 * (`preflight:detectAgents`, Re-detect is `preflight:refreshAgents`) with the
 * default, the availability switch and the command override the ADE keeps
 * (`defaultTuiAgent`, `disabledTuiAgents`, `agentCmdOverrides`), then the ones
 * not installed with their install docs. Local detection only; the ADE's
 * runtime-environment target is not offered here.
 */
export class OrcaAgentsList {

	private _detected: ReadonlySet<string> | undefined;
	private _failed = false;
	private _refreshing = false;
	private _requested = false;

	constructor(private readonly _host: IOrcaAgentsListHost) { }

	/** Detects once; the screen calls it each time the pane is drawn. */
	load(): void {
		if (this._requested) {
			return;
		}
		this._requested = true;
		void this._detect(() => this._host.invoke<readonly string[] | undefined>('preflight:detectAgents'));
	}

	private async _detect(probe: () => Promise<readonly string[] | undefined>): Promise<void> {
		this._refreshing = true;
		this._host.redraw();
		try {
			this._detected = new Set(await probe() ?? []);
			this._failed = false;
		} catch {
			this._failed = this._detected === undefined;
		}
		this._refreshing = false;
		this._host.redraw();
	}

	private _refresh(): void {
		void this._detect(async () => (await this._host.invoke<{ agents?: readonly string[] } | undefined>('preflight:refreshAgents'))?.agents);
	}

	render(parent: HTMLElement): void {
		const detected = this._detected;
		const installed = detected ? KINGU_TUI_AGENTS.filter(agent => detected.has(agent.id)) : [];
		const head = append(parent, $('.kingu-orca-settings-subsection-header.kingu-orca-agents-head'));
		append(head, $('h3')).textContent = detected
			? localize('kingu.agents.installedCount', "Installed ({0})", installed.length)
			: localize('kingu.agents.installed', "Installed");
		smallButton(head, 'outline', 'refresh-cw', localize('kingu.agents.redetect', "Re-detect"), () => this._refresh(), this._refreshing);

		if (!detected) {
			append(parent, $('p.kingu-orca-settings-description')).textContent = this._failed
				? localize('kingu.agents.failed', "Couldn't detect installed agents. Try Re-detect.")
				: localize('kingu.agents.detecting', "Detecting installed agents…");
			return;
		}
		if (installed.length === 0) {
			append(parent, $('p.kingu-orca-settings-description')).textContent = localize('kingu.agents.none', "No agents detected. If one is installed, the probe may have timed out; try Re-detect.");
		} else {
			const list = append(parent, $('.kingu-orca-settings-list.kingu-orca-agents-list'));
			for (const agent of installed) {
				this._installedRow(list, agent);
			}
		}

		const missing = KINGU_TUI_AGENTS.filter(agent => !detected.has(agent.id));
		if (missing.length) {
			const title = append(parent, $('.kingu-orca-settings-subsection-header.kingu-orca-agents-head'));
			append(title, $('h3')).textContent = localize('kingu.agents.availableCount', "Available to Install ({0})", missing.length);
			const list = append(parent, $('.kingu-orca-settings-list.kingu-orca-agents-list'));
			for (const agent of missing) {
				const row = append(list, $('.kingu-orca-settings-list-row.kingu-orca-agent-row.missing'));
				this._name(row, agent);
				const actions = append(row, $('.kingu-orca-agent-actions'));
				smallButton(actions, 'ghost', 'download', localize('kingu.agents.install', "Install"), () => this._host.openExternal(agent.docsUrl));
			}
		}
	}

	private _name(row: HTMLElement, agent: IKinguTuiAgent): HTMLElement {
		const text = append(row, $('.kingu-orca-settings-list-text'));
		const label = append(text, $('span.kingu-orca-settings-list-label.kingu-orca-agent-name'));
		label.appendChild(providerIcon(agent.id));
		append(label, $('span')).textContent = agent.label;
		return text;
	}

	private _installedRow(list: HTMLElement, agent: IKinguTuiAgent): void {
		const defaultAgent = this._host.value('defaultTuiAgent');
		const rawDisabled = this._host.value('disabledTuiAgents');
		const disabled = Array.isArray(rawDisabled) ? rawDisabled.filter((id): id is string => typeof id === 'string') : [];
		const overrides = { ...(this._host.value('agentCmdOverrides') ?? {}) as Record<string, string> };
		const enabled = !disabled.includes(agent.id);

		const row = append(list, $('.kingu-orca-settings-list-row.kingu-orca-agent-row'));
		row.classList.toggle('disabled', !enabled);
		const text = this._name(row, agent);
		const command = append(text, $('input.kingu-orca-input.kingu-orca-agent-command')) as HTMLInputElement;
		command.placeholder = agent.command;
		command.value = overrides[agent.id] ?? '';
		command.title = localize('kingu.agents.commandTitle', "The command Kingu runs for {0}; empty runs \"{1}\"", agent.label, agent.command);
		command.setAttribute('aria-label', localize('kingu.agents.commandAria', "Command for {0}", agent.label));
		command.addEventListener('blur', () => {
			const next = command.value.trim();
			if (next === (overrides[agent.id] ?? '')) {
				return;
			}
			if (next) {
				overrides[agent.id] = next;
			} else {
				delete overrides[agent.id];
			}
			void this._host.update({ agentCmdOverrides: overrides });
		});
		command.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				command.blur();
			} else if (event.key === 'Escape') {
				command.value = overrides[agent.id] ?? '';
				command.blur();
			}
		});

		const actions = append(row, $('.kingu-orca-agent-actions'));
		smallButton(actions, 'ghost', 'external-link', localize('kingu.agents.docs', "Docs"), () => this._host.openExternal(agent.docsUrl));
		if (defaultAgent === agent.id) {
			append(actions, $('span.kingu-orca-account-badge.normal')).textContent = localize('kingu.agents.default', "Default");
		} else if (enabled) {
			smallButton(actions, 'outline', undefined, localize('kingu.agents.setDefault', "Set Default"), () => void this._host.update({ defaultTuiAgent: agent.id }));
		}
		const toggle = append(actions, $('button.kingu-orca-switch')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', String(enabled));
		toggle.setAttribute('aria-label', localize('kingu.agents.enabledAria', "Offer {0}", agent.label));
		toggle.classList.toggle('checked', enabled);
		append(toggle, $('span.kingu-orca-switch-thumb'));
		toggle.addEventListener('click', () => void this._host.update(agentAvailabilityUpdate(defaultAgent, disabled, agent.id, !enabled)));
	}
}
