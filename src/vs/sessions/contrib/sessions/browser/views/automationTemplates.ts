/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IReader } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IAutomationSchedule } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import { isContributionEnabled } from '../../../../../workbench/contrib/chat/common/enablement.js';
import { IAgentPlugin } from '../../../../../workbench/contrib/chat/common/plugins/agentPluginService.js';

export interface IAutomationTemplateSource {
	readonly label: string;
	readonly uri: URI;
}

export interface IAutomationTemplate {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
	readonly schedule: IAutomationSchedule;
	readonly source?: IAutomationTemplateSource;
	readonly enabled?: boolean;
}

export const AUTOMATION_TEMPLATES: readonly IAutomationTemplate[] = [
	// Kingu: Arkai's recipes, goose-style tasks written for a small local model
	// (Chyle 1): short steps, one job each, and nothing changed without asking.
	// GitHub's issue triage is left out: Kingu never needs a GitHub account.
	{
		id: 'kingu-daily-summary',
		name: localize('automationTemplate.kinguDailySummary.name', "Daily work summary"),
		description: localize('automationTemplate.kinguDailySummary.description', "Sum up today's commits and the changes not yet committed."),
		prompt: localize('automationTemplate.kinguDailySummary.prompt', "Summarize today's work in this repository.\n\n1. Run `git log --since=midnight --stat --no-merges` and read the commits made today.\n2. Run `git status --short` and `git diff --stat` to see what is changed but not committed.\n3. Write a short summary: what was done (grouped by feature or area), what is still uncommitted, and anything that looks unfinished (TODO, commented-out code, failing builds you noticed).\n\nDo not change, stage or commit any file. If there are no commits today, say so and summarize only the uncommitted changes."),
		schedule: { interval: 'daily', scheduleHour: 17, scheduleMinute: 30, scheduleDay: 0 },
	},
	{
		id: 'kingu-test-health',
		name: localize('automationTemplate.kinguTestHealth.name', "Test health check"),
		description: localize('automationTemplate.kinguTestHealth.description', "Run the project's tests and explain any that fail."),
		prompt: localize('automationTemplate.kinguTestHealth.prompt', "Check that this project's tests pass.\n\n1. Find how the project runs its tests: package.json scripts, composer.json, Makefile, pytest, go test or cargo test. Pick the one main test command.\n2. Run it once.\n3. If everything passes, report the command and the number of tests.\n4. If tests fail, list each failing test with the file, the error message and your best guess at the cause, citing the code you read.\n\nDo not edit code or tests to make them pass. If no test command can be found, say which files you looked at."),
		schedule: { interval: 'daily', scheduleHour: 8, scheduleMinute: 30, scheduleDay: 0 },
	},
	{
		id: 'kingu-todo-sweep',
		name: localize('automationTemplate.kinguTodoSweep.name', "TODO sweep"),
		description: localize('automationTemplate.kinguTodoSweep.description', "Collect TODO and FIXME notes and pick the ones worth doing first."),
		prompt: localize('automationTemplate.kinguTodoSweep.prompt', "Collect the TODO, FIXME and HACK notes in this repository.\n\n1. Search the source files for TODO, FIXME and HACK, skipping node_modules, vendor, build output and lock files.\n2. Group the notes by folder or feature.\n3. Pick the five that matter most (bugs, security, data loss, user-visible problems first) and for each give the file and line, what it means, and a short suggestion.\n\nDo not change any file."),
		schedule: { interval: 'weekly', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 },
	},
	{
		id: 'kingu-dependency-check',
		name: localize('automationTemplate.kinguDependencyCheck.name', "Dependency check"),
		description: localize('automationTemplate.kinguDependencyCheck.description', "Find outdated packages and known security advisories."),
		prompt: localize('automationTemplate.kinguDependencyCheck.prompt', "Check this project's dependencies.\n\n1. Find the package managers in use: npm, pnpm, yarn or bun (package.json), Composer (composer.json), pip (requirements.txt or pyproject.toml), Go (go.mod), Cargo (Cargo.toml).\n2. For each, run its read-only outdated and audit commands, for example `npm outdated` and `npm audit`, `composer outdated` and `composer audit`, `pip list --outdated`.\n3. Report security advisories first (package, severity, fixed version), then major version updates, then the rest in one line each.\n\nDo not install, update or remove any package."),
		schedule: { interval: 'weekly', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 },
	},
	{
		id: 'kingu-release-notes',
		name: localize('automationTemplate.kinguReleaseNotes.name', "Draft release notes"),
		description: localize('automationTemplate.kinguReleaseNotes.description', "Write release notes from the commits since the last tag."),
		prompt: localize('automationTemplate.kinguReleaseNotes.prompt', "Draft release notes for the next release.\n\n1. Find the latest tag with `git describe --tags --abbrev=0`. If there is none, use the last 50 commits.\n2. Read the commits since then with `git log <tag>..HEAD --no-merges`.\n3. Write release notes in Markdown with the sections New, Improved, Fixed and Breaking changes, one short line per change in words a user understands. Leave out internal chores.\n\nShow the notes in your answer; do not create files, tags or commits."),
		schedule: { interval: 'manual', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 },
	},
	{
		id: 'main-updates',
		name: localize('automationTemplate.mainUpdates.name', "Catch up on main"),
		description: localize('automationTemplate.mainUpdates.description', "Pull the latest main and summarize new commits."),
		prompt: localize('automationTemplate.mainUpdates.prompt', "Pull the latest main and summarize the commits that were pulled.\n\nInspect this repository's current branch, working tree, and configured remotes. Resolve the remote for main from the repository configuration rather than assuming origin. Record HEAD, then pull that remote's main into the current checkout using --ff-only. Proceed only with a clean working tree and a fast-forward update. If the remote is ambiguous, main is missing, or the update is blocked, stop and explain why. Do not switch branches, stash or discard local changes, rebase, or force an update.\n\nCompare the starting and ending HEAD and summarize only newly pulled commits, grouped by theme. Highlight user-visible changes, bug fixes, breaking changes, and follow-up actions. Include commit links and related pull requests when available. If no commits were pulled, say so."),
		schedule: { interval: 'daily', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 0 },
	},
	{
		id: 'find-bugs',
		name: localize('automationTemplate.findBugs.name', "Find bugs"),
		description: localize('automationTemplate.findBugs.description', "Explore the codebase and report verified, reproducible bugs."),
		prompt: localize('automationTemplate.findBugs.prompt', "Explore this codebase and find concrete, reproducible bugs.\n\nRead the repository guidance and understand the architecture before choosing a focused area to investigate, such as recent changes, complex state transitions, or error handling. Trace suspected problems through callers and existing tests. Use the smallest relevant tests or a minimal reproduction to verify behavior, and distinguish confirmed bugs from hypotheses. Avoid style-only suggestions and speculative findings.\n\nReport high-confidence, actionable bugs with severity, file and line references, a triggering scenario, expected versus actual behavior, and supporting test or reproduction results. Suggest a focused fix for each finding without modifying repository files or committing changes. State what you explored, any validation limitations, and when no confirmed bugs were found."),
		schedule: { interval: 'weekly', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 },
	},
];

export function readAutomationTemplates(plugins: readonly IAgentPlugin[], reader?: IReader): readonly IAutomationTemplate[] {
	const templates = [...AUTOMATION_TEMPLATES];
	for (const plugin of plugins) {
		const enablement = reader ? plugin.enablement.read(reader) : plugin.enablement.get();
		if (!isContributionEnabled(enablement)) {
			continue;
		}
		const automations = reader ? plugin.automations.read(reader) : plugin.automations.get();
		for (const automation of automations) {
			templates.push({
				id: `${plugin.uri.toString()}#automation=${automation.blueprint.id}`,
				name: automation.blueprint.name,
				description: automation.blueprint.description ?? localize('automationTemplate.pluginDescription', "Provided by {0}.", plugin.label),
				prompt: automation.blueprint.prompt,
				schedule: automation.blueprint.schedule,
				source: { label: plugin.label, uri: automation.uri },
				enabled: false,
			});
		}
	}
	return templates;
}
