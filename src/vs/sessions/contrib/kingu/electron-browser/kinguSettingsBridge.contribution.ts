/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationDefaults, IConfigurationNode, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { IKinguSettingEquivalent, KINGU_SETTING_EQUIVALENTS, orcaValueFor, vscodeValueFor } from '../common/kinguOrcaSettingEquivalents.js';
import { orcaSettingId, orcaSettingIdForKey, orcaSettingsById, orcaSettingsPatch } from '../common/kinguOrcaSettings.js';
import { KINGU_ORCA_SETTINGS, KINGU_ORCA_SETTINGS_PAGES } from '../common/kinguOrcaSettingsSchema.js';
import './kinguOrcaService.js';

const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** The ADE settings that are also one of this window's own, by this window's id for the ADE key. */
const boundByOrcaId = new Map<string, IKinguSettingEquivalent>();
for (const equivalent of KINGU_SETTING_EQUIVALENTS) {
	const id = orcaSettingIdForKey(equivalent.orcaKey);
	if (id !== undefined) {
		boundByOrcaId.set(id, equivalent);
	}
}

/**
 * The ADE's settings, in this window's Settings editor — all of the ones the
 * ADE's own settings pages offer, under those pages' names.
 *
 * Registered as ordinary configuration so they behave the way every other
 * setting here behaves: searchable, typed, editable as JSON.
 *
 * **Defaults come from the running ADE.** Several of the ADE's defaults depend
 * on the machine — the workspace folder, the platform's fonts — so the schema
 * carries none, and once the ADE answers, each setting's default becomes the
 * value the ADE holds. `settings.json` then contains only what the user changed.
 *
 * **What the user sets wins, and goes down through `settings:set`** — the
 * ADE's own handler rather than its store, because the handler is where a value
 * is acted on (hooks installed, a proxy applied), not just saved.
 *
 * **Settings both programs have are one setting** ({@link KINGU_SETTING_EQUIVALENTS}).
 * The terminal font size is `terminal.integrated.fontSize`, because that is
 * what the terminals in this window read; the ADE's own is shown beside it,
 * shows the same value, and editing it edits the VS Code one. The ADE is kept
 * in step either way, so its engine — and the ADE's own window, when it runs —
 * use the same size. Where the two disagree on first meeting, a value the user
 * set in VS Code wins; otherwise the ADE's carries over, so nothing chosen in
 * the ADE is lost to a VS Code default.
 */
class KinguSettingsBridgeContribution extends Disposable {

	static readonly ID = 'kingu.contrib.settingsBridge';

	/** The default override in force per id, kept so it can be withdrawn when the value moves. */
	private readonly _defaults = new Map<string, IConfigurationDefaults>();

	/** What the ADE holds, by its own key, as last read or written. */
	private readonly _orcaValues = new Map<string, unknown>();

	constructor(
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		void this._reconcile();

		this._register(this._configurationService.onDidChangeConfiguration(event => {
			// A default moving is this bridge publishing a value; only what the
			// user wrote goes back down.
			if (event.source === ConfigurationTarget.DEFAULT) {
				return;
			}
			const changed: Record<string, unknown> = {};
			for (const setting of KINGU_ORCA_SETTINGS) {
				const id = orcaSettingId(setting);
				const bound = boundByOrcaId.get(id);
				if (bound) {
					if (event.affectsConfiguration(bound.vscodeKey)) {
						void this._followVsCode(id, bound);
					} else if (event.affectsConfiguration(id)) {
						void this._moveToVsCode(id, bound, true);
					}
					continue;
				}
				if (event.affectsConfiguration(id) && this._configurationService.inspect(id).user !== undefined) {
					changed[id] = this._configurationService.getValue(id);
				}
			}
			if (Object.keys(changed).length > 0) {
				void this._write(orcaSettingsPatch(changed));
			}
		}));

		// The ADE tells every window but the one that wrote, so this carries only
		// changes made elsewhere — by the ADE itself, or by a migration.
		this._register(this._orca.onPush('settings:changed')(([updates]) => {
			const values = updates as Record<string, unknown>;
			this._remember(values);
			const unbound: Record<string, unknown> = {};
			for (const [id, value] of Object.entries(orcaSettingsById(values))) {
				const bound = boundByOrcaId.get(id);
				if (bound) {
					// VS Code's value is the one kept; put the ADE back in step with it.
					void this._followVsCode(id, bound);
				} else {
					unbound[id] = value;
				}
			}
			this._adoptDefaults(unbound);
		}));

		this._register({ dispose: () => registry.deregisterDefaultConfigurations([...this._defaults.values()]) });
	}

	/**
	 * Once, at startup: the ADE's values become the defaults, anything the user
	 * has set goes down, and each bound pair is brought into line with VS Code.
	 */
	private async _reconcile(): Promise<void> {
		try {
			const settings = await this._orca.invoke<Record<string, unknown>>('settings:get');
			this._remember(settings);
			const unbound: Record<string, unknown> = {};
			for (const [id, value] of Object.entries(orcaSettingsById(settings))) {
				if (!boundByOrcaId.has(id)) {
					unbound[id] = value;
				}
			}
			this._adoptDefaults(unbound);

			const userValues: Record<string, unknown> = {};
			for (const setting of KINGU_ORCA_SETTINGS) {
				const id = orcaSettingId(setting);
				const bound = boundByOrcaId.get(id);
				if (bound) {
					// Set by hand on the ADE's side before the two were bound: it moves to
					// VS Code if VS Code has nothing of the user's own, and goes either way.
					await this._moveToVsCode(id, bound, false);
					await this._carryOrcaIntoVsCode(bound);
					await this._followVsCode(id, bound);
					continue;
				}
				const value = this._configurationService.inspect(id).userValue;
				if (value !== undefined) {
					userValues[id] = value;
				}
			}
			if (Object.keys(userValues).length > 0) {
				await this._write(orcaSettingsPatch(userValues));
			}
		} catch (error) {
			this._logService.error('[kingu-settings] could not reconcile the ADE settings', error);
		}
	}

	/**
	 * The first time a pair meets: what the ADE holds becomes VS Code's value,
	 * unless VS Code already holds something of the user's own.
	 *
	 * Without this, VS Code's *default* would win, and a font size someone chose
	 * in the ADE would be quietly reset to VS Code's the first time this window
	 * opened. The ADE's store cannot say which of its values were chosen and
	 * which are its defaults, so all of them carry over; after that the two
	 * agree, and this does nothing.
	 */
	private async _carryOrcaIntoVsCode(bound: IKinguSettingEquivalent): Promise<void> {
		const orcaValue = this._orcaValues.get(bound.orcaKey);
		if (orcaValue === undefined || this._configurationService.inspect(bound.vscodeKey).userValue !== undefined) {
			return;
		}
		const current = this._configurationService.getValue(bound.vscodeKey);
		const value = vscodeValueFor(bound, orcaValue, current);
		if (value === undefined || equals(value, current)) {
			return;
		}
		try {
			await this._configurationService.updateValue(bound.vscodeKey, value, ConfigurationTarget.USER);
		} catch (error) {
			this._logService.error(`[kingu-settings] could not carry ${bound.orcaKey} into ${bound.vscodeKey}`, error);
		}
	}

	/**
	 * Carries VS Code's value to the ADE side of a pair: the ADE setting shows
	 * it, and the ADE is told if it disagrees.
	 */
	private async _followVsCode(id: string, bound: IKinguSettingEquivalent): Promise<void> {
		const current = this._orcaValues.get(bound.orcaKey);
		const value = orcaValueFor(bound, this._configurationService.getValue(bound.vscodeKey), current);
		if (value === undefined) {
			// VS Code says nothing the ADE can use; show what the ADE has.
			if (current !== undefined) {
				this._adoptDefaults({ [id]: current });
			}
			return;
		}
		this._adoptDefaults({ [id]: value });
		if (!equals(value, current)) {
			await this._write({ [bound.orcaKey]: value });
		}
	}

	/**
	 * A value the user wrote on the ADE side of a pair becomes VS Code's value,
	 * and the ADE-side entry is withdrawn so the pair stays one setting.
	 *
	 * An edit made now always wins — the user just chose it. One left over from
	 * before the two were bound only moves if VS Code holds nothing of the
	 * user's own, since that one is what their terminals have been using.
	 */
	private async _moveToVsCode(id: string, bound: IKinguSettingEquivalent, freshEdit: boolean): Promise<void> {
		const written = this._configurationService.inspect(id).userValue;
		if (written === undefined) {
			return;
		}
		try {
			if (freshEdit || this._configurationService.inspect(bound.vscodeKey).userValue === undefined) {
				const value = vscodeValueFor(bound, written, this._configurationService.getValue(bound.vscodeKey));
				await this._configurationService.updateValue(bound.vscodeKey, value, ConfigurationTarget.USER);
			}
			await this._configurationService.updateValue(id, undefined, ConfigurationTarget.USER);
		} catch (error) {
			this._logService.error(`[kingu-settings] could not move ${id} to ${bound.vscodeKey}`, error);
		}
	}

	/** Makes these values this window's defaults, replacing any earlier ones. */
	private _adoptDefaults(valuesById: Record<string, unknown>): void {
		const withdrawn: IConfigurationDefaults[] = [];
		const added: IConfigurationDefaults[] = [];
		for (const [id, value] of Object.entries(valuesById)) {
			const previous = this._defaults.get(id);
			if (previous && equals(previous.overrides[id], value)) {
				continue;
			}
			if (previous) {
				withdrawn.push(previous);
			}
			const next: IConfigurationDefaults = { overrides: { [id]: value }, donotCache: true };
			this._defaults.set(id, next);
			added.push(next);
		}
		if (withdrawn.length > 0) {
			registry.deregisterDefaultConfigurations(withdrawn);
		}
		if (added.length > 0) {
			registry.registerDefaultConfigurations(added);
		}
	}

	private _remember(settings: Record<string, unknown> | undefined): void {
		for (const [key, value] of Object.entries(settings ?? {})) {
			this._orcaValues.set(key, value);
		}
	}

	/** Sends a patch, in the ADE's keys, through the ADE's own `settings:set`. */
	private async _write(patch: Record<string, unknown>): Promise<void> {
		if (Object.keys(patch).length === 0) {
			return;
		}
		try {
			await this._orca.invoke('settings:set', patch);
			this._remember(patch);
		} catch (error) {
			this._logService.error('[kingu-settings] could not write the ADE settings', error);
		}
	}
}

/**
 * One configuration node per ADE settings page, in the ADE's order, so the
 * Settings editor files each setting where the ADE does.
 */
const nodes: IConfigurationNode[] = KINGU_ORCA_SETTINGS_PAGES.map((page, index) => {
	const properties: Record<string, IConfigurationPropertySchema> = {};
	for (const setting of KINGU_ORCA_SETTINGS) {
		if (setting.page !== page.id) {
			continue;
		}
		const id = orcaSettingId(setting);
		const bound = boundByOrcaId.get(id);
		const boundNote = bound ? localize('kingu.settings.bound', "Same setting as {0}: changing either one changes both.", `\`#${bound.vscodeKey}#\``) : undefined;
		properties[id] = {
			type: setting.type as IConfigurationPropertySchema['type'],
			...(setting.enum ? { enum: [...setting.enum] } : {}),
			...(boundNote
				? { markdownDescription: setting.description ? `${setting.description}\n\n${boundNote}` : boundNote }
				: setting.description ? { description: setting.description } : {}),
		};
	}
	return {
		id: `kingu.${page.id}`,
		title: localize('kingu.settings.pageTitle', "Kingu: {0}", page.title),
		order: index,
		properties,
	};
});
registry.registerConfigurations(nodes);

registerWorkbenchContribution2(KinguSettingsBridgeContribution.ID, KinguSettingsBridgeContribution, WorkbenchPhase.AfterRestored);
