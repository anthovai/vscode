/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { KINGU_BRIDGED_SETTINGS, KINGU_SETTINGS_CHANNEL_NAME } from '../../../../platform/kinguSettings/common/kinguSettings.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

/**
 * The ADE's settings, in this window's Settings editor.
 *
 * Registered as ordinary configuration so they behave the way every other
 * setting in this window behaves — searchable, typed, overridable per profile,
 * editable as JSON. Nothing about them announces that the thing they change
 * lives in the ADE, which is the point of merging the two.
 *
 * The user's settings are the source of truth, and this pushes them down. The
 * other direction is carried too, but only to keep the editor honest: a
 * setting changed inside the ADE is written back so Settings does not go on
 * showing a value nothing holds any more.
 */
class KinguSettingsBridgeContribution extends Disposable {

	static readonly ID = 'kingu.contrib.settingsBridge';

	private readonly _channel: IChannel;
	/** Keys this window is mid-write on, so the echo back does not loop. */
	private readonly _writing = new Set<string>();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._channel = mainProcessService.getChannel(KINGU_SETTINGS_CHANNEL_NAME);

		// Adopt what the ADE already holds before listening, so a first run shows
		// the ADE's real values rather than this window's defaults — and so the
		// first edit is a change from what the user had, not from a default they
		// never chose.
		void this._adopt();

		this._register(this._configurationService.onDidChangeConfiguration(event => {
			const changed: Record<string, unknown> = {};
			for (const setting of KINGU_BRIDGED_SETTINGS) {
				if (event.affectsConfiguration(setting.id) && !this._writing.has(setting.id)) {
					changed[setting.id] = this._configurationService.getValue(setting.id);
				}
			}
			if (Object.keys(changed).length > 0) {
				void this._channel.call('write', changed);
			}
		}));

		this._register(this._channel.listen<Record<string, unknown>>('onDidChange')(values => {
			void this._apply(values);
		}));
	}

	/**
	 * Reconciles the two stores once, at startup, and the direction is per key.
	 *
	 * **A key the user has set wins**, and is pushed down to the ADE. The first
	 * version of this adopted every key the other way and silently rewrote
	 * `settings.json` with the ADE's values — so a setting the user had changed
	 * by hand was reverted by opening the window, which is the worst way for a
	 * settings bridge to be wrong.
	 *
	 * **A key the user has never set adopts the ADE's value**, so Settings shows
	 * what is actually in force rather than a default nothing holds. Nothing is
	 * written where the two already agree, so this does not turn every ADE
	 * default into an explicit user setting.
	 */
	private async _adopt(): Promise<void> {
		try {
			const fromOrca = await this._channel.call<Record<string, unknown>>('read');
			const toOrca: Record<string, unknown> = {};
			const toWindow: Record<string, unknown> = {};
			for (const setting of KINGU_BRIDGED_SETTINGS) {
				const userValue = this._configurationService.inspect(setting.id).user?.value;
				if (userValue !== undefined) {
					toOrca[setting.id] = userValue;
				} else if (fromOrca[setting.id] !== undefined) {
					toWindow[setting.id] = fromOrca[setting.id];
				}
			}
			await this._apply(toWindow);
			if (Object.keys(toOrca).length > 0) {
				await this._channel.call('write', toOrca);
			}
		} catch (error) {
			this._logService.error('[kingu-settings] could not reconcile the ADE settings', error);
		}
	}

	/**
	 * Writes the ADE's values into this window's configuration.
	 *
	 * Skipped where they already agree: writing an identical value still stamps
	 * the key into `settings.json`, which would turn every default the ADE
	 * happens to hold into an explicit user setting the first time this ran.
	 */
	private async _apply(values: Record<string, unknown>): Promise<void> {
		for (const [id, value] of Object.entries(values)) {
			if (this._configurationService.getValue(id) === value) {
				continue;
			}
			this._writing.add(id);
			try {
				await this._configurationService.updateValue(id, value, ConfigurationTarget.USER);
			} catch (error) {
				this._logService.error(`[kingu-settings] could not apply ${id}`, error);
			} finally {
				this._writing.delete(id);
			}
		}
	}
}

const properties: IConfigurationNode['properties'] = {};
for (const setting of KINGU_BRIDGED_SETTINGS) {
	properties[setting.id] = {
		type: setting.type,
		default: setting.default,
		description: setting.description,
		...(setting.enum ? { enum: [...setting.enum] } : {}),
		...(setting.enumDescriptions ? { enumDescriptions: [...setting.enumDescriptions] } : {}),
	};
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu',
	title: localize('kingu.settings.title', "Kingu"),
	properties,
});

registerWorkbenchContribution2(KinguSettingsBridgeContribution.ID, KinguSettingsBridgeContribution, WorkbenchPhase.AfterRestored);
