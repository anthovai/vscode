/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { normalizeOrcaAwakeMode } from './kinguOrcaFooter.js';
import { IKinguOrcaSettingSchema, KINGU_ORCA_SETTINGS } from './kinguOrcaSettingsSchema.js';

/**
 * The ADE's settings as this window names them: `kingu.<page>.<key>`.
 *
 * The page is the ADE's settings page, so the Settings editor files each one
 * where the ADE does — `kingu.git.branchPrefix` reads as *Git: Branch Prefix*
 * under Kingu. The key is the ADE's own, verbatim, so the id can always be
 * turned back into what the ADE calls it.
 */
export function orcaSettingId(setting: IKinguOrcaSettingSchema): string {
	return `kingu.${setting.page}.${setting.key}`;
}

const settingByKey = new Map(KINGU_ORCA_SETTINGS.map(setting => [setting.key, setting]));
const settingById = new Map(KINGU_ORCA_SETTINGS.map(setting => [orcaSettingId(setting), setting]));

/** This window's id for one of the ADE's keys, if the key is offered. */
export function orcaSettingIdForKey(key: string): string | undefined {
	const setting = settingByKey.get(key);
	return setting ? orcaSettingId(setting) : undefined;
}

/** The ADE's key for one of this window's ids, if the id is one of the ADE's. */
export function orcaKeyForSettingId(id: string): string | undefined {
	return settingById.get(id)?.key;
}

/**
 * The ADE's settings object, keyed by this window's ids; keys not offered are dropped.
 *
 * `computerAwakeMode` is read the way the ADE reads it: a profile that predates
 * it holds only the legacy boolean, and the mode is derived from that — left
 * as it is, the setting would show no value at all.
 */
export function orcaSettingsById(settings: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
	const byId: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(settings ?? {})) {
		const id = orcaSettingIdForKey(key);
		if (id !== undefined && value !== undefined) {
			byId[id] = value;
		}
	}
	const awakeId = orcaSettingIdForKey('computerAwakeMode');
	if (awakeId !== undefined && byId[awakeId] === undefined && settings?.keepComputerAwakeWhileAgentsRun !== undefined) {
		byId[awakeId] = normalizeOrcaAwakeMode(undefined, settings.keepComputerAwakeWhileAgentsRun);
	}
	return byId;
}

/**
 * What to hand the ADE's `settings:set` for changes made here.
 *
 * Mostly a rename back to the ADE's keys. One setting is written as two, as the
 * ADE writes it: `computerAwakeMode` carries the legacy boolean alongside it,
 * which older ADE builds read instead and which is not offered on its own.
 */
export function orcaSettingsPatch(updatesById: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const [id, value] of Object.entries(updatesById)) {
		const key = orcaKeyForSettingId(id);
		if (key === undefined) {
			continue;
		}
		patch[key] = value;
		if (key === 'computerAwakeMode') {
			patch.keepComputerAwakeWhileAgentsRun = value === 'on' || value === 'auto';
		}
	}
	return patch;
}
