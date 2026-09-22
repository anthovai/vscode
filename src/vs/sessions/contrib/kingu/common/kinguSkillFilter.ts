/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IKinguSkill, IKinguSkillSource, KINGU_SHARED_SKILL_OWNER, KinguSkillSourceKind } from './kinguSkills.js';
import { KINGU_VAULT_SOURCES } from './kinguVaultSources.js';

/** Every filter the page can be in, as one value. */
export interface IKinguSkillFilter {
	readonly query: string;
	readonly sourceKind: KinguSkillSourceKind | 'all';
	/** An owning agent id, {@link KINGU_SHARED_SKILL_OWNER}, or `'all'`. */
	readonly owner: string;
}

export const KINGU_SKILL_FILTER_NONE: IKinguSkillFilter = { query: '', sourceKind: 'all', owner: 'all' };

/**
 * How long a query may be before it is treated as a paste rather than a search.
 *
 * Someone pasting a whole file into the box is not searching, and matching it
 * against every skill costs a full scan of the corpus to return nothing.
 */
export const KINGU_SKILL_QUERY_MAX_LENGTH = 2048;

/**
 * What the sources list says a root belongs to.
 *
 * Only the agents whose *skills* directories this window scans; the vault's
 * labels are reused where the two tables name the same agent, so an agent is
 * not called two different things in two places in one window.
 */
const EXTRA_OWNER_LABELS = new Map<string, string>([
	['continue', localize('kingu.skills.owner.continue', "Continue")],
	['trae', localize('kingu.skills.owner.trae', "Trae")],
	['aug', localize('kingu.skills.owner.aug', "Augment")],
]);

export function kinguSkillOwnerLabel(owner: string): string {
	if (owner === KINGU_SHARED_SKILL_OWNER) {
		return localize('kingu.skills.owner.shared', "Shared (.agents)");
	}
	const vault = KINGU_VAULT_SOURCES.find(source => source.id === owner);
	return vault?.label ?? EXTRA_OWNER_LABELS.get(owner) ?? owner;
}

export function kinguSkillSourceKindLabel(kind: KinguSkillSourceKind): string {
	switch (kind) {
		// "Repository" would misname half of these: a `repo` root is any open
		// folder, and plenty of them are not repositories. "Workspace" is what
		// the rest of this window already calls an open folder.
		case 'repo': return localize('kingu.skills.kind.workspace', "Workspace");
		case 'home': return localize('kingu.skills.kind.home', "Home");
		case 'bundled': return localize('kingu.skills.kind.bundled', "Bundled");
		case 'plugin': return localize('kingu.skills.kind.plugin', "Plugin");
	}
}

/**
 * Which agent each root belongs to.
 *
 * The scan tags every root that is not Codex's or Claude's own format as
 * `agent-skills`, and keeps the real agent on the *source*. So the owning agent
 * of a skill has to come from the root it was found in — its provider list
 * would say `agent-skills` for a dozen different agents.
 */
export function kinguSkillOwnerByRoot(sources: readonly IKinguSkillSource[]): ReadonlyMap<string, string> {
	return new Map(sources.map(source => [source.path, source.owner]));
}

/** Membership only: it stops at the first owning root rather than building the list. */
export function kinguSkillMatchesOwner(skill: IKinguSkill, owner: string, ownerByRoot: ReadonlyMap<string, string>): boolean {
	if (owner === 'all') {
		return true;
	}
	if (!owner) {
		return false;
	}
	return skill.rootPaths.some(root => ownerByRoot.get(root) === owner);
}

export interface IKinguSkillOwnerOption {
	readonly id: string;
	readonly label: string;
	readonly count: number;
}

/**
 * The agents worth offering as a filter: the ones that actually hold a skill.
 *
 * An agent with an empty skills directory is not a filter — picking it would
 * empty the list, which tells the user nothing they did not already see.
 */
export function kinguSkillOwnerOptions(skills: readonly IKinguSkill[], sources: readonly IKinguSkillSource[]): IKinguSkillOwnerOption[] {
	const ownerByRoot = kinguSkillOwnerByRoot(sources);
	const counts = new Map<string, number>();
	for (const skill of skills) {
		const owners = new Set<string>();
		for (const root of skill.rootPaths) {
			const owner = ownerByRoot.get(root);
			if (owner) {
				owners.add(owner);
			}
		}
		for (const owner of owners) {
			counts.set(owner, (counts.get(owner) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([id, count]) => ({ id, label: kinguSkillOwnerLabel(id), count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

export function filterKinguSkills(
	skills: readonly IKinguSkill[],
	filter: IKinguSkillFilter,
	ownerByRoot: ReadonlyMap<string, string>,
): IKinguSkill[] {
	if (filter.query.length > KINGU_SKILL_QUERY_MAX_LENGTH) {
		return [];
	}
	const query = normalize(filter.query);
	return skills.filter(skill => {
		if (filter.sourceKind !== 'all' && skill.sourceKind !== filter.sourceKind) {
			return false;
		}
		if (!kinguSkillMatchesOwner(skill, filter.owner, ownerByRoot)) {
			return false;
		}
		if (!query) {
			return true;
		}
		// The path is in the haystack on purpose: "what is in my .claude folder"
		// is one of the two questions people bring to this page, and the other
		// one is "what did I call that skill".
		const haystack = [
			skill.name,
			skill.description ?? '',
			skill.sourceLabel,
			skill.directoryPath,
			skill.providers.join(' '),
		].join(' ').toLowerCase();
		return haystack.includes(query);
	});
}

export function countKinguSkillsByKind(skills: readonly IKinguSkill[]): Record<KinguSkillSourceKind, number> {
	const counts: Record<KinguSkillSourceKind, number> = { home: 0, repo: 0, bundled: 0, plugin: 0 };
	for (const skill of skills) {
		counts[skill.sourceKind] += 1;
	}
	return counts;
}

/**
 * Roughly two lines at the width the detail pane uses.
 *
 * Past this the description gets a disclosure rather than pushing the path and
 * the actions off the bottom of the pane.
 */
export const KINGU_SKILL_DESCRIPTION_CLAMP = 160;

export function isLongKinguSkillDescription(description: string | undefined): boolean {
	return (description?.trim().length ?? 0) > KINGU_SKILL_DESCRIPTION_CLAMP;
}
