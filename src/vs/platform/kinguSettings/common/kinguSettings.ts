/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

export const KINGU_SETTINGS_CHANNEL_NAME = 'kinguSettings';

/**
 * One setting the ADE owns, offered in this window's Settings editor.
 *
 * The ADE's settings surface is 476 files and about three hundred keys, and
 * most of them describe chrome this window does not have — its sidebar, its tab
 * strip, its own title bar. Registering all of them would fill Settings with
 * controls that change nothing here, which is worse than not offering them.
 *
 * So the table below is a deliberate subset, and the rule it applies is: a
 * setting earns a place when the behaviour it changes is behaviour *this*
 * window has. Each entry names the ADE's own key, so adding one later is a row
 * rather than a translation layer.
 */
export interface IKinguSettingDescriptor {
	/** The key in the ADE's `GlobalSettings`, verbatim. */
	readonly key: string;
	/** What this window calls it, always under `kingu.`. */
	readonly id: string;
	readonly type: 'boolean' | 'string';
	/** The ADE's own default, so an unset value reads the same on both sides. */
	readonly default: boolean | string;
	readonly description: string;
	/** Present when the ADE accepts only a few values. */
	readonly enum?: readonly string[];
	readonly enumDescriptions?: readonly string[];
}

export const KINGU_BRIDGED_SETTINGS: readonly IKinguSettingDescriptor[] = [
	{
		key: 'agentStatusHooksEnabled',
		id: 'kingu.agents.statusHooks',
		type: 'boolean',
		default: true,
		description: localize('kingu.settings.statusHooks', "Write a status hook into each agent's own configuration, so an agent reports what it is doing instead of being guessed at from its output."),
	},
	{
		key: 'computerAwakeMode',
		id: 'kingu.agents.keepAwake',
		type: 'string',
		default: 'off',
		enum: ['auto', 'on', 'off'],
		enumDescriptions: [
			localize('kingu.settings.keepAwake.auto', "Keep the machine awake only while an agent is working."),
			localize('kingu.settings.keepAwake.on', "Keep the machine awake while Kingu is running."),
			localize('kingu.settings.keepAwake.off', "Never keep the machine awake."),
		],
		description: localize('kingu.settings.keepAwake', "Whether Kingu stops the machine sleeping under a working agent, which would otherwise suspend a long run partway through."),
	},
	{
		key: 'branchPrefix',
		id: 'kingu.git.branchPrefix',
		type: 'string',
		default: 'git-username',
		enum: ['git-username', 'custom', 'none'],
		enumDescriptions: [
			localize('kingu.settings.branchPrefix.gitUsername', "Prefix a new branch with the name Git is configured with."),
			localize('kingu.settings.branchPrefix.custom', "Prefix it with the value of `kingu.git.branchPrefixCustom`."),
			localize('kingu.settings.branchPrefix.none', "No prefix."),
		],
		description: localize('kingu.settings.branchPrefixDescription', "What Kingu puts in front of a branch name it creates for a worktree."),
	},
	{
		key: 'branchPrefixCustom',
		id: 'kingu.git.branchPrefixCustom',
		type: 'string',
		default: '',
		description: localize('kingu.settings.branchPrefixCustom', "The prefix used when `kingu.git.branchPrefix` is `custom`."),
	},
	{
		key: 'skipDeleteWorktreeConfirm',
		id: 'kingu.confirm.skipDeleteWorktree',
		type: 'boolean',
		default: false,
		description: localize('kingu.settings.skipDeleteWorktree', "Delete a worktree without asking. Deleting one removes its working directory from disk."),
	},
	{
		key: 'skipCloseTerminalWithRunningProcessConfirm',
		id: 'kingu.confirm.skipCloseBusyTerminal',
		type: 'boolean',
		default: false,
		description: localize('kingu.settings.skipCloseBusyTerminal', "Close a terminal that still has a process running without asking. Closing one kills that process."),
	},
];
