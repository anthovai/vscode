/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileType, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import {
	IKinguSkill,
	IKinguSkillScan,
	IKinguSkillSource,
	IKinguSkillsService,
	KinguSkillSkipReason,
	stripUnsafeDisplayCharacters,
} from '../common/kinguSkills.js';
import { summarizeKinguSkill } from '../common/kinguSkillMetadata.js';
import {
	IKinguSkillRoot,
	KINGU_SKILL_FILE_NAME,
	KINGU_SKILL_HOME_ROOTS,
	kinguSkillDirectoryMaxDepth,
	kinguSkillSourceKind,
	kinguSkillSourceLabel,
	kinguSkillWorkspaceRoots,
	sortKinguSkillSources,
	sortKinguSkills,
} from '../common/kinguSkillSources.js';

/**
 * How many `SKILL.md` files are opened at once.
 *
 * The same number the vault walks at, and for the same reason: the file service
 * is shared with the rest of the window, and a scan that saturates it makes
 * everything else in the window feel broken while it runs.
 */
const READ_CONCURRENCY = 8;

/**
 * How much of a `SKILL.md` is read to describe it.
 *
 * Front matter and the opening paragraph are the whole of what the list shows,
 * and they are at the top. A skill whose body is a 200 KB reference document is
 * common; paying for all of it to fill one description cell is not.
 */
const DESCRIBE_PREFIX_BYTES = 64 * 1024;

/**
 * Every skill the agents on this machine can see.
 *
 * Ported from the ADE's skill discovery, with two things changed. The file
 * access is {@link IFileService}, because this renderer is sandboxed and the
 * file service is already what reaches disk from it. And the WSL half is gone:
 * the ADE runs a second discovery through `find -maxdepth` inside a distro
 * because its renderer cannot see that filesystem, whereas a WSL folder opened
 * in this window is served to the same file service as everything else.
 *
 * Held in memory and rebuilt on demand rather than persisted, matching the
 * vault: these are the user's own files, and a copy of them on disk is
 * something they did not ask for.
 */
export class KinguSkillsService extends Disposable implements IKinguSkillsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSkills = this._register(new Emitter<void>());
	readonly onDidChangeSkills = this._onDidChangeSkills.event;

	private _scan: Promise<IKinguSkillScan> | undefined;
	/**
	 * The scan's own token, which only this service cancels.
	 *
	 * A caller's token must not reach the shared walk: two views mounting would
	 * otherwise abort the scan the other one is waiting on, and the partial
	 * result it stopped at would be cached as the whole answer.
	 */
	private readonly _scanning = this._register(new CancellationTokenSource());

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		// A folder opened or closed changes which `.claude/skills` are in scope,
		// so the next read of the page walks again rather than showing the skills
		// of a project that is no longer open.
		this._register(this._contextService.onDidChangeWorkspaceFolders(() => this.invalidate()));
	}

	getSkills(token: CancellationToken): Promise<IKinguSkillScan> {
		if (!this._scan) {
			this._scan = this._walkAll(this._scanning.token);
		}
		const scan = this._scan;
		return new Promise((resolve, reject) => {
			const listener = token.onCancellationRequested(() => reject(new Error('Cancelled')));
			scan.then(resolve, reject).finally(() => listener.dispose());
		});
	}

	async readSkill(resource: URI): Promise<string> {
		const content = await this._fileService.readFile(resource);
		return content.value.toString();
	}

	invalidate(): void {
		this._scan = undefined;
		this._onDidChangeSkills.fire();
	}

	private async _walkAll(token: CancellationToken): Promise<IKinguSkillScan> {
		const home = await this._pathService.userHome();
		const roots: { root: IKinguSkillRoot; base: URI }[] = [
			...KINGU_SKILL_HOME_ROOTS.map(root => ({ root, base: home })),
		];
		for (const folder of this._contextService.getWorkspace().folders) {
			for (const root of kinguSkillWorkspaceRoots(folder.name, folder.index.toString())) {
				roots.push({ root, base: folder.uri });
			}
		}

		const sources: IKinguSkillSource[] = [];
		/** Keyed by resource, so one file reached through two roots is one row. */
		const skills = new Map<string, { skill: IKinguSkill; rootPaths: string[] }>();

		for (const { root, base } of roots) {
			if (token.isCancellationRequested) {
				break;
			}
			const resource = joinPath(base, ...root.segments);
			const reachable = await this._reachable(resource);
			sources.push({
				id: root.id,
				label: root.label,
				path: resource.path,
				resource,
				sourceKind: root.sourceKind,
				providers: root.providers,
				owner: root.owner,
				exists: reachable === undefined,
				skippedReason: reachable,
			});
			if (reachable !== undefined) {
				continue;
			}
			try {
				await this._collect(resource, root, skills, token);
			} catch (error) {
				// Per root, so one agent whose layout has changed under us cannot
				// empty the whole page.
				this._logService.warn(`[Kingu] skill scan failed for ${root.id}`, error);
			}
		}

		const found = [...skills.values()].map(entry => ({ ...entry.skill, rootPaths: entry.rootPaths }));
		this._logService.trace(`[Kingu] skill scan: ${found.length} skills across ${sources.filter(source => source.exists).length} roots`);
		return {
			skills: sortKinguSkills(found),
			sources: sortKinguSkillSources(sources),
			scannedAt: Date.now(),
		};
	}

	/**
	 * Whether a root can be walked, and if not, why.
	 *
	 * The distinction is the point. A root that is not there is the ordinary
	 * case — nobody has every agent installed — and says nothing worth showing.
	 * A root that exists and will not open holds an unknown number of skills,
	 * and reporting that as zero would be a wrong answer wearing the shape of a
	 * right one.
	 */
	private async _reachable(resource: URI): Promise<KinguSkillSkipReason | undefined> {
		try {
			return await this._fileService.exists(resource) ? undefined : 'missing';
		} catch {
			return 'unreadable';
		}
	}

	private async _collect(
		root: URI,
		definition: IKinguSkillRoot,
		into: Map<string, { skill: IKinguSkill; rootPaths: string[] }>,
		token: CancellationToken,
	): Promise<void> {
		const files = await this._walk(root, definition, [], token);
		await forEachLimited(files, READ_CONCURRENCY, async file => {
			if (token.isCancellationRequested) {
				return;
			}
			const key = file.resource.toString();
			const existing = into.get(key);
			if (existing) {
				// One file, two roots — a skill symlinked or shared into a second
				// agent's directory. Keeping only the first root would drop it out
				// of the second agent's filter, which is the one question the
				// agent filter exists to answer.
				if (!existing.rootPaths.includes(root.path)) {
					existing.rootPaths.push(root.path);
				}
				return;
			}
			const skill = await this._describe(file.resource, file.relativeSegments, definition, root);
			if (skill) {
				into.set(key, { skill, rootPaths: [root.path] });
			}
		});
	}

	/** Every `SKILL.md` under `directory`, to the depth this kind of root allows. */
	private async _walk(
		directory: URI,
		definition: IKinguSkillRoot,
		relativeSegments: readonly string[],
		token: CancellationToken,
	): Promise<{ resource: URI; relativeSegments: string[] }[]> {
		if (relativeSegments.length > kinguSkillDirectoryMaxDepth(definition.sourceKind) || token.isCancellationRequested) {
			return [];
		}
		const found: { resource: URI; relativeSegments: string[] }[] = [];
		for (const entry of await this._children(directory)) {
			const segments = [...relativeSegments, entry.name];
			const resource = joinPath(directory, entry.name);
			if (entry.type === FileType.Directory) {
				found.push(...await this._walk(resource, definition, segments, token));
				continue;
			}
			if (entry.name.toLowerCase() === KINGU_SKILL_FILE_NAME) {
				found.push({ resource, relativeSegments: segments });
			}
		}
		return found;
	}

	private async _describe(
		resource: URI,
		relativeSegments: readonly string[],
		definition: IKinguSkillRoot,
		root: URI,
	): Promise<IKinguSkill | undefined> {
		let updatedAt: number | undefined;
		try {
			updatedAt = (await this._fileService.stat(resource)).mtime;
		} catch {
			// The walk saw it a moment ago; if it has gone since, it is not a skill
			// this page should claim exists.
			return undefined;
		}

		const markdown = await this._read(resource);
		const summary = markdown === undefined ? { name: undefined, description: undefined } : summarizeKinguSkill(markdown);
		const directorySegments = relativeSegments.slice(0, -1);
		// The directory name is the fallback because it is what every agent
		// actually addresses the skill by; the front matter is only what it calls
		// itself.
		const name = summary.name ?? stripUnsafeDisplayCharacters(directorySegments.at(-1) ?? relativeSegments.at(-1) ?? '');
		if (!name) {
			return undefined;
		}
		const sourceKind = kinguSkillSourceKind(definition.sourceKind, relativeSegments);
		const directory = resource.with({ path: resource.path.slice(0, resource.path.lastIndexOf('/')) });
		return {
			id: resource.toString(),
			name,
			description: summary.description,
			providers: definition.providers,
			sourceKind,
			sourceLabel: kinguSkillSourceLabel(definition.label, sourceKind, definition.sourceKind),
			rootPath: root.path,
			rootPaths: [root.path],
			directoryPath: directory.path,
			directory,
			resource,
			updatedAt,
		};
	}

	private async _read(resource: URI): Promise<string | undefined> {
		try {
			const content = await this._fileService.readFile(resource, { position: 0, length: DESCRIBE_PREFIX_BYTES });
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	private async _children(resource: URI): Promise<{ name: string; type: FileType }[]> {
		try {
			const stat = await this._fileService.resolve(resource);
			return stat.children?.map(child => ({ name: child.name, type: child.isDirectory ? FileType.Directory : FileType.File })) ?? [];
		} catch {
			return [];
		}
	}
}

/** Runs `body` over `items` with at most `limit` in flight. */
async function forEachLimited<T>(items: readonly T[], limit: number, body: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			await body(items[next++]);
		}
	});
	await Promise.all(workers);
}

function joinPath(base: URI, ...segments: string[]): URI {
	return base.with({ path: `${base.path.replace(/\/+$/, '')}/${segments.join('/')}` });
}
