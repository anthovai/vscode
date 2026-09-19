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
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import {
	findExcerpt,
	IKinguVaultSearchResult,
	IKinguVaultService,
	IKinguVaultSession,
	readFirstUserPrompt,
	readJsonDocumentDescriptor,
	readRecordedTitle,
	readWorkingDirectory,
	sessionTitle,
} from '../common/kinguVault.js';
import { IKinguVaultSourceDefinition, KINGU_VAULT_SOURCES, pathSegments } from '../common/kinguVaultSources.js';
import { getKinguVaultEnvironmentSource, IKinguVaultEnvironment } from '../common/kinguVaultEnvironment.js';

/**
 * How many transcripts are opened at once.
 *
 * A heavy user has thousands, and reading them all in parallel starves the file
 * service that the rest of the window shares.
 */
const SCAN_CONCURRENCY = 8;

/**
 * How much of a transcript is read to describe it.
 *
 * Everything that names a session sits at the top: the title records come first
 * and the opening prompt follows within a few. A long-running session's
 * transcript runs to tens of megabytes, so reading them whole to pull one line
 * out of the head made the scan cost scale with how much work the user had done.
 */
const DESCRIBE_PREFIX_BYTES = 128 * 1024;

/**
 * How much of a transcript search reads.
 *
 * A bound is needed for the same reason, and unlike the title this one does lose
 * something: a hit past the cut is not found. It is set high enough to cover an
 * ordinary session whole.
 */
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;

/**
 * Indexes the sessions other coding agents have left on this machine.
 *
 * Ported from the Kingu ADE's vault scanner, with the file access rewritten onto
 * {@link IFileService}: the Agents window renderer is sandboxed, and the file
 * service is what already knows how to reach disk from it — a second path would
 * mean a second permission model.
 *
 * The walk is driven by {@link KINGU_VAULT_SOURCES} rather than by a scanner per
 * agent, so a new agent is a table entry.
 *
 * The index is held in memory and rebuilt on demand rather than persisted. These
 * files are the user's own working history, and a cache of their prompts on disk
 * is a copy of something private that they never asked us to make.
 */
export class KinguVaultService extends Disposable implements IKinguVaultService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private _sessions: Promise<readonly IKinguVaultSession[]> | undefined;
	/**
	 * The scan's own token, which only this service cancels.
	 *
	 * A caller's token must never reach the shared scan: two views mounting, or one
	 * re-rendering, would otherwise abort the walk every other caller is waiting on
	 * — and the short result it stopped at would be cached as the whole vault.
	 */
	private readonly _scanning = this._register(new CancellationTokenSource());

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	getSessions(token = CancellationToken.None): Promise<readonly IKinguVaultSession[]> {
		if (token.isCancellationRequested) {
			return Promise.resolve([]);
		}
		// Cached as the promise rather than its result so concurrent callers share
		// one scan instead of each starting their own. The caller's token is not
		// passed on: it says when that caller stopped caring, not when the scan
		// should stop. See {@link _scanning}.
		this._sessions ??= this._scan(this._scanning.token);
		return this._sessions;
	}

	invalidate(): void {
		this._sessions = undefined;
		this._onDidChangeSessions.fire();
	}

	async search(query: string, token = CancellationToken.None): Promise<readonly IKinguVaultSearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) {
			return [];
		}
		const sessions = await this.getSessions(token);
		const results: IKinguVaultSearchResult[] = [];
		await forEachLimited(sessions, SCAN_CONCURRENCY, async session => {
			if (token.isCancellationRequested) {
				return;
			}
			// Both halves are searched for the agents that split a session in two,
			// so a hit in the turns is found from the manifest that names them.
			for (const resource of [session.resource, session.contentResource]) {
				const text = resource && await this._read(resource, MAX_SEARCH_BYTES);
				const excerpt = text && findExcerpt(text, trimmed);
				if (excerpt) {
					results.push({ session, excerpt });
					return;
				}
			}
		});
		// Re-sorted because the bounded walk completes out of order.
		return results.sort((a, b) => b.session.modified - a.session.modified);
	}

	private async _scan(token: CancellationToken): Promise<readonly IKinguVaultSession[]> {
		const [home, environment] = await Promise.all([
			this._pathService.userHome(),
			this._environment(),
		]);
		// The local home first, so a duplicate root reached two ways keeps the
		// spelling the user would recognise.
		const homes = [home, ...environment?.homeDirectories ?? []];
		const sessions: IKinguVaultSession[] = [];
		const seen = new Set<string>();
		// Per source, so one agent whose layout has changed under us cannot empty
		// the whole vault.
		for (const source of KINGU_VAULT_SOURCES) {
			if (token.isCancellationRequested) {
				break;
			}
			try {
				for (const session of await this._scanSource(homes, environment, source, token)) {
					// A root reached both by default and by an override is one directory,
					// and its sessions must not be listed twice.
					if (!seen.has(session.id)) {
						seen.add(session.id);
						sessions.push(session);
					}
				}
			} catch (error) {
				this._logService.warn(`[Kingu] vault scan failed for ${source.id}`, error);
			}
		}
		return sessions.sort((a, b) => b.modified - a.modified);
	}

	/** What the host knows about other homes and moved roots, when anything does. */
	private async _environment(): Promise<IKinguVaultEnvironment | undefined> {
		try {
			return await getKinguVaultEnvironmentSource()?.resolve();
		} catch (error) {
			// The vault is still readable without it; it just sees less.
			this._logService.warn('[Kingu] could not resolve the vault environment', error);
			return undefined;
		}
	}

	private async _scanSource(
		homes: readonly URI[],
		environment: IKinguVaultEnvironment | undefined,
		source: IKinguVaultSourceDefinition,
		token: CancellationToken,
	): Promise<IKinguVaultSession[]> {
		const roots: URI[] = [];
		for (const home of homes) {
			for (const rootSegments of source.roots) {
				roots.push(joinPath(home, ...rootSegments));
			}
		}
		// An override names one absolute directory, so it is a root in its own right
		// rather than something to resolve against each home.
		for (const override of environment?.rootOverrides.get(source.id) ?? []) {
			roots.push(URI.file(override));
		}

		const sessions: IKinguVaultSession[] = [];
		for (const root of roots) {
			const files = await this._walk(root, source, [], token);
			await forEachLimited(files, SCAN_CONCURRENCY, async file => {
				if (token.isCancellationRequested) {
					return;
				}
				const session = await this._describe(file.resource, source, file.relativeSegments);
				if (session) {
					sessions.push(session);
				}
			});
		}
		return sessions;
	}

	/** Every file under `directory` that `source` would surface, to its bounded depth. */
	private async _walk(
		directory: URI,
		source: IKinguVaultSourceDefinition,
		relativeSegments: readonly string[],
		token: CancellationToken,
	): Promise<{ resource: URI; relativeSegments: string[] }[]> {
		const depth = relativeSegments.length;
		if (depth > source.maxDepth || token.isCancellationRequested) {
			return [];
		}
		const found: { resource: URI; relativeSegments: string[] }[] = [];
		for (const entry of await this._children(directory)) {
			const segments = [...relativeSegments, entry.name];
			const resource = joinPath(directory, entry.name);
			if (entry.type === FileType.Directory) {
				if (!source.directoryPredicate || source.directoryPredicate(entry.name, depth)) {
					found.push(...await this._walk(resource, source, segments, token));
				}
				continue;
			}
			if (matchesFile(source, segments)) {
				found.push({ resource, relativeSegments: segments });
			}
		}
		return found;
	}

	private async _describe(resource: URI, source: IKinguVaultSourceDefinition, relativeSegments: readonly string[]): Promise<IKinguVaultSession | undefined> {
		let modified: number;
		try {
			modified = (await this._fileService.stat(resource)).mtime ?? 0;
		} catch {
			return undefined;
		}
		const contentResource = this._contentResource(resource, source);
		const fromPath = source.workingDirectoryFromPath?.(relativeSegments);
		const head = await this._read(resource, DESCRIBE_PREFIX_BYTES);
		if (head === undefined) {
			return this._nameOnly(resource, source, contentResource, fromPath, modified);
		}

		let title: string | undefined;
		let workingDirectory: string | undefined;
		if (source.isJsonDocument) {
			const descriptor = readJsonDocumentDescriptor(head);
			title = descriptor.title;
			workingDirectory = descriptor.workingDirectory;
		} else {
			// The recorded title wins: it is what the session turned out to be about,
			// whereas the opening prompt is only where it started.
			title = readRecordedTitle(head) ?? readFirstUserPrompt(head);
			workingDirectory = readWorkingDirectory(head);
		}

		// A manifest that names nothing still has its turns beside it.
		if (!title && contentResource) {
			const turns = await this._read(contentResource, DESCRIBE_PREFIX_BYTES);
			title = turns ? readFirstUserPrompt(turns) : undefined;
		}

		return {
			id: `${source.id}:${resource.path}`,
			source: source.id,
			sourceLabel: source.label,
			resource,
			contentResource,
			title: sessionTitle(title, basename(resource)),
			workingDirectory: workingDirectory ?? fromPath,
			modified,
		};
	}

	private _contentResource(resource: URI, source: IKinguVaultSourceDefinition): URI | undefined {
		const path = source.contentPath?.(resource.path);
		return path ? resource.with({ path }) : undefined;
	}

	/** A session we could not read the body of still belongs in the list. */
	private _nameOnly(resource: URI, source: IKinguVaultSourceDefinition, contentResource: URI | undefined, workingDirectory: string | undefined, modified: number): IKinguVaultSession {
		return {
			id: `${source.id}:${resource.path}`,
			source: source.id,
			sourceLabel: source.label,
			resource,
			contentResource,
			title: basename(resource),
			workingDirectory,
			modified,
		};
	}

	/** At most `length` bytes from the start of a file, or `undefined` if unreadable. */
	private async _read(resource: URI, length: number): Promise<string | undefined> {
		try {
			const content = await this._fileService.readFile(resource, { position: 0, length });
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
			// A source the user has never used has no directory, which is the common case.
			return [];
		}
	}
}

/** Whether a file at `segments` below a source's root is one of its sessions. */
function matchesFile(source: IKinguVaultSourceDefinition, segments: readonly string[]): boolean {
	const name = segments[segments.length - 1];
	const dot = name.lastIndexOf('.');
	const extension = dot === -1 ? '' : name.slice(dot).toLowerCase();
	if (!source.extensions.includes(extension)) {
		return false;
	}
	return !source.filePredicate || source.filePredicate(segments);
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

function basename(resource: URI): string {
	return pathSegments(resource.path).at(-1) ?? resource.path;
}
