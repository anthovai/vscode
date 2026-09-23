/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationDefaults, IConfigurationNode, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { orcaSettingId, orcaSettingsById, orcaSettingsPatch } from '../common/kinguOrcaSettings.js';
import { KINGU_ORCA_SETTINGS, KINGU_ORCA_SETTINGS_PAGES } from '../common/kinguOrcaSettingsSchema.js';
import './kinguOrcaService.js';

const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/**
 * The ADE's settings, in this window's Settings editor — all of the ones the
 * ADE's own settings pages offer, under those pages' names.
 *
 * Registered as ordinary configuration so they behave the way every other
 * setting here behaves: searchable, typed, editable as JSON. Nothing about them
 * announces that what they change lives in the ADE, which is the point.
 *
 * **Defaults come from the running ADE.** Several of the ADE's defaults depend
 * on the machine — the workspace folder, the platform's fonts — so the schema
 * carries none, and once the ADE answers, each setting's default becomes the
 * value the ADE holds. The Settings editor then shows what is in force, and
 * `settings.json` contains only what the user changed.
 *
 * **What the user sets wins, and goes down through `settings:set`** — the
 * ADE's own handler rather than its store, because the handler is where a value
 * is acted on (hooks installed, a proxy applied), not just saved.
 */
class KinguSettingsBridgeContribution extends Disposable {

	static readonly ID = 'kingu.contrib.settingsBridge';

	/** The default override in force per id, kept so it can be withdrawn when the ADE's value moves. */
	private readonly _defaults = new Map<string, IConfigurationDefaults>();

	constructor(
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		void this._reconcile();

		this._register(this._configurationService.onDidChangeConfiguration(event => {
			// A default moving is the ADE telling us its value; only what the user
			// wrote goes back down.
			if (event.source === ConfigurationTarget.DEFAULT) {
				return;
			}
			const changed: Record<string, unknown> = {};
			for (const setting of KINGU_ORCA_SETTINGS) {
				const id = orcaSettingId(setting);
				if (event.affectsConfiguration(id) && this._configurationService.inspect(id).user !== undefined) {
					changed[id] = this._configurationService.getValue(id);
				}
			}
			if (Object.keys(changed).length > 0) {
				void this._write(changed);
			}
		}));

		// The ADE tells every window but the one that wrote, so this carries only
		// changes made elsewhere — by the ADE itself, or by a migration.
		this._register(this._orca.onPush('settings:changed')(([updates]) => {
			this._adoptDefaults(orcaSettingsById(updates as Record<string, unknown>));
		}));

		this._register({ dispose: () => registry.deregisterDefaultConfigurations([...this._defaults.values()]) });
	}

	/**
	 * Once, at startup: the ADE's values become the defaults, and anything the
	 * user has set is sent down, since theirs is the value that should hold.
	 */
	private async _reconcile(): Promise<void> {
		try {
			this._adoptDefaults(orcaSettingsById(await this._orca.invoke<Record<string, unknown>>('settings:get')));
			const userValues: Record<string, unknown> = {};
			for (const setting of KINGU_ORCA_SETTINGS) {
				const id = orcaSettingId(setting);
				const value = this._configurationService.inspect(id).userValue;
				if (value !== undefined) {
					userValues[id] = value;
				}
			}
			if (Object.keys(userValues).length > 0) {
				await this._write(userValues);
			}
		} catch (error) {
			this._logService.error('[kingu-settings] could not reconcile the ADE settings', error);
		}
	}

	/** Makes the ADE's values this window's defaults, replacing any earlier ones. */
	private _adoptDefaults(valuesById: Record<string, unknown>): void {
		const withdrawn: IConfigurationDefaults[] = [];
		const added: IConfigurationDefaults[] = [];
		for (const [id, value] of Object.entries(valuesById)) {
			const previous = this._defaults.get(id);
			if (previous && previous.overrides[id] === value) {
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

	private async _write(updatesById: Record<string, unknown>): Promise<void> {
		try {
			await this._orca.invoke('settings:set', orcaSettingsPatch(updatesById));
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
		properties[orcaSettingId(setting)] = {
			type: setting.type as IConfigurationPropertySchema['type'],
			...(setting.enum ? { enum: [...setting.enum] } : {}),
			...(setting.description ? { description: setting.description } : {}),
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
