/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileType, IFileService } from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import {
	findExcerpt,
	IKinguUsageSummary,
	IKinguVaultSearchOptions,
	IKinguVaultSearchOutcome,
	IKinguVaultSearchResult,
	IKinguVaultService,
	KinguVaultSearchStop,
	IKinguVaultSession,
	KinguVaultSource,
	readFirstUserPrompt,
	readJsonDocumentDescriptor,
	readRecordedTitle,
	readWorkingDirectory,
	sessionTitle,
} from '../common/kinguVault.js';
import { IKinguVaultSourceDefinition, isDiscoverable, KINGU_VAULT_SOURCES, pathSegments, vaultSource } from '../common/kinguVaultSources.js';
import { addUsage, EMPTY_USAGE, IKinguUsage, readTranscriptUsage } from '../common/kinguVaultUsage.js';
import {
	isSubagentTranscriptName,
	readSubagentMeta,
	subagentMetaPathFor,
	subagentsDirectoryFor,
	subagentTitle,
} from '../common/kinguVaultSubagents.js';
import { getKinguVaultEnvironmentSource, IKinguVaultEnvironment } from '../common/kinguVaultEnvironment.js';
import { IKinguVaultHost, remoteVaultHosts } from '../common/kinguVaultRemote.js';
import { createScanTally, IKinguVaultFileStamp, IKinguVaultScanTally, KinguVaultDescriptionCache } from '../common/kinguVaultCache.js';
import { groupSearchByHost, KinguSearchLedger, searchBudgetFor } from '../common/kinguVaultSearchBudget.js';
import { IRemoteAgentHostService } from '../../../../platform/agentHost/common/remoteAgentHostService.js';

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
 * What the local machine is called when a host has to be named.
 *
 * A local session carries no host label, because the list would be a wall of
 * "this computer"; the one place the name is needed is a report that a search
 * did not finish, where "some machine" would be useless.
 */
const LOCAL_HOST_KEY = localize('kingu.vault.localHost', "this machine");

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
	/**
	 * What each transcript was last described as.
	 *
	 * Deliberately outlives {@link invalidate}, which is the point: invalidation
	 * says the *set* of sessions may have changed, not that every transcript was
	 * rewritten. The scan re-walks the directories and re-stats the files, and
	 * pays to read only the ones whose stat moved.
	 */
	private readonly _descriptions = new KinguVaultDescriptionCache();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@ILogService private readonly _logService: ILogService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
	) {
		super();
		// A host connecting or dropping changes which transcripts exist to be
		// listed, so the index is rebuilt rather than left describing a machine
		// this window can no longer read.
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => this.invalidate()));
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

	async search(query: string, options: IKinguVaultSearchOptions = {}, token = CancellationToken.None): Promise<IKinguVaultSearchOutcome> {
		const trimmed = query.trim();
		const sessions = trimmed ? await this.getSessions(token) : [];
		if (!trimmed) {
			return { results: [], searched: 0, total: 0, stopped: 'complete', truncatedHosts: [] };
		}

		const maxResults = options.maxResults ?? Number.POSITIVE_INFINITY;
		const results: IKinguVaultSearchResult[] = [];
		const truncated = new Set<string>();
		let searched = 0;
		let stopped: KinguVaultSearchStop = 'complete';

		// Each machine walks under its own allowance and its own number of reads in
		// flight, and the machines walk at the same time. One host being slow or
		// unreachable therefore delays only its own half of the answer — which is
		// the whole point of searching across hosts rather than one after another.
		await Promise.all([...groupSearchByHost(sessions)].map(async ([hostLabel, hostSessions]) => {
			const ledger = new KinguSearchLedger(searchBudgetFor(hostLabel !== undefined));
			await forEachLimited(hostSessions, ledger.budget.concurrency, async session => {
				if (token.isCancellationRequested) {
					stopped = 'cancelled';
					return;
				}
				if (results.length >= maxResults) {
					stopped = 'maxResults';
					return;
				}
				const allowance = ledger.claim();
				if (allowance === 0) {
					// Named rather than passed over: a search that quietly skipped half a
					// host would read as "no matches there", which is a different answer.
					truncated.add(hostLabel ?? LOCAL_HOST_KEY);
					if (stopped === 'complete') {
						stopped = 'budget';
					}
					return;
				}
				searched++;
				let used = 0;
				// Both halves are searched for the agents that split a session in two,
				// so a hit in the turns is found from the manifest that names them.
				for (const resource of [session.resource, session.contentResource]) {
					const text = resource && await this._read(resource, allowance - used);
					used += text?.length ?? 0;
					const excerpt = text && findExcerpt(text, trimmed);
					if (excerpt) {
						const result = { session, excerpt };
						results.push(result);
						options.onResult?.(result);
						break;
					}
					if (used >= allowance) {
						break;
					}
				}
				ledger.refund(allowance, used);
			});
		}));

		return {
			// Re-sorted because the bounded walk completes out of order.
			results: results.sort((a, b) => b.session.modified - a.session.modified).slice(0, maxResults),
			searched,
			total: sessions.length,
			stopped,
			truncatedHosts: [...truncated],
		};
	}

	private async _scan(token: CancellationToken): Promise<readonly IKinguVaultSession[]> {
		const tally = createScanTally();
		const [home, environment] = await Promise.all([
			this._pathService.userHome(),
			this._environment(),
		]);
		// The local home first, so a duplicate root reached two ways keeps the
		// spelling the user would recognise.
		const hosts: IKinguVaultHost[] = [
			...[home, ...environment?.homeDirectories ?? []].map(uri => ({ home: uri, label: undefined })),
			...remoteVaultHosts(this._remoteAgentHostService.connections),
		];
		const sessions: IKinguVaultSession[] = [];
		const seen = new Set<string>();
		// Per source, so one agent whose layout has changed under us cannot empty
		// the whole vault.
		for (const source of KINGU_VAULT_SOURCES) {
			if (token.isCancellationRequested) {
				break;
			}
			try {
				for (const session of await this._scanSource(hosts, environment, source, tally, token)) {
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
		// Logged because the reuse rate is the whole reason a rescan over a remote
		// host is affordable, and a cache that silently stopped working would look
		// like nothing more than a slow window.
		this._logService.trace(`[Kingu] vault scan: ${sessions.length} sessions, ${tally.reused} reused, ${tally.read} read, ${hosts.length} hosts`);
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
		hosts: readonly IKinguVaultHost[],
		environment: IKinguVaultEnvironment | undefined,
		source: IKinguVaultSourceDefinition,
		tally: IKinguVaultScanTally,
		token: CancellationToken,
	): Promise<IKinguVaultSession[]> {
		const roots: { resource: URI; hostLabel: string | undefined }[] = [];
		for (const host of hosts) {
			for (const rootSegments of source.roots) {
				roots.push({ resource: joinPath(host.home, ...rootSegments), hostLabel: host.label });
			}
		}
		// An override names one absolute directory, so it is a root in its own right
		// rather than something to resolve against each home. It is always local:
		// it came from this machine's environment.
		for (const override of environment?.rootOverrides.get(source.id) ?? []) {
			roots.push({ resource: URI.file(override), hostLabel: undefined });
		}

		const sessions: IKinguVaultSession[] = [];
		for (const root of roots) {
			const files = await this._walk(root.resource, source, [], token);
			await forEachLimited(files, SCAN_CONCURRENCY, async file => {
				if (token.isCancellationRequested) {
					return;
				}
				const session = await this._describe(file.resource, source, file.relativeSegments, root.hostLabel, tally);
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

	private async _describe(resource: URI, source: IKinguVaultSourceDefinition, relativeSegments: readonly string[], hostLabel?: string, tally?: IKinguVaultScanTally): Promise<IKinguVaultSession | undefined> {
		let modified: number;
		let stamp: IKinguVaultFileStamp;
		try {
			const stat = await this._fileService.stat(resource);
			modified = stat.mtime ?? 0;
			stamp = { mtime: modified, size: stat.size };
		} catch {
			return undefined;
		}
		// The stat is the whole cost of a session that has not changed since the
		// last scan, which is nearly all of them on nearly every scan.
		const key = resource.toString();
		const cached = this._descriptions.get(key, stamp, tally);
		if (cached) {
			return cached;
		}
		const contentResource = this._contentResource(resource, source);
		const fromPath = source.workingDirectoryFromPath?.(relativeSegments);
		const head = await this._read(resource, DESCRIBE_PREFIX_BYTES);
		if (head === undefined) {
			// Deliberately not cached: the read failed, and a host that was briefly
			// unreachable must not have its whole corpus pinned as name-only.
			return this._nameOnly(resource, source, contentResource, fromPath, modified, relativeSegments, hostLabel);
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

		const session: IKinguVaultSession = {
			id: sessionId(source.id, resource),
			source: source.id,
			sourceLabel: source.label,
			rootRelativeSegments: relativeSegments,
			resource,
			contentResource,
			title: sessionTitle(title, basename(resource)),
			workingDirectory: workingDirectory ?? fromPath,
			modified,
			hostLabel,
		};
		this._descriptions.set(key, stamp, session, tally);
		return session;
	}

	async getSubagents(session: IKinguVaultSession, token = CancellationToken.None): Promise<readonly IKinguVaultSession[]> {
		const directory = subagentsDirectoryFor(session.resource.path);
		if (!directory) {
			return [];
		}
		const root = session.resource.with({ path: directory });
		const entries = await this._children(root);
		const subagents: IKinguVaultSession[] = [];
		await forEachLimited(entries, SCAN_CONCURRENCY, async entry => {
			if (token.isCancellationRequested || entry.type === FileType.Directory || !isSubagentTranscriptName(entry.name)) {
				return;
			}
			const described = await this._describeSubagent(joinPath(root, entry.name), session);
			if (described) {
				subagents.push(described);
			}
		});
		return subagents.sort((a, b) => b.modified - a.modified);
	}

	private async _describeSubagent(resource: URI, parent: IKinguVaultSession): Promise<IKinguVaultSession | undefined> {
		let modified: number;
		try {
			modified = (await this._fileService.stat(resource)).mtime ?? 0;
		} catch {
			return undefined;
		}
		// The sidecar is what the parent wrote to say what it was delegating, which
		// beats the opening line of the instructions it then handed over.
		const metaPath = subagentMetaPathFor(resource.path);
		const metaContent = metaPath ? await this._read(resource.with({ path: metaPath }), DESCRIBE_PREFIX_BYTES) : undefined;
		const meta = readSubagentMeta(metaContent ?? '');
		const head = await this._read(resource, DESCRIBE_PREFIX_BYTES);
		return {
			id: sessionId(parent.source, resource),
			source: parent.source,
			sourceLabel: parent.sourceLabel,
			// A worker's transcript is reached through its parent, never by a root
			// scan, so it is not a delete target in its own right.
			rootRelativeSegments: [],
			resource,
			contentResource: undefined,
			title: subagentTitle(meta, head ? readFirstUserPrompt(head) : undefined, basename(resource)),
			workingDirectory: parent.workingDirectory,
			modified,
			hostLabel: parent.hostLabel,
		};
	}

	async getUsage(session: IKinguVaultSession, token = CancellationToken.None): Promise<IKinguUsage> {
		if (token.isCancellationRequested) {
			return EMPTY_USAGE;
		}
		// Bounded like search, and for the same reason: a pathological transcript
		// must not decide how long this takes, and a remote one is read over a link
		// the agent is also using.
		const transcript = await this._read(session.resource, searchBudgetFor(session.hostLabel !== undefined).perSessionBytes);
		return transcript ? readTranscriptUsage(transcript, session.source) : EMPTY_USAGE;
	}

	async getUsageSummary(token = CancellationToken.None, onProgress?: (done: number, total: number) => void): Promise<IKinguUsageSummary> {
		const sessions = await this.getSessions(token);
		const bySource = new Map<KinguVaultSource, IKinguUsage>();
		let total = EMPTY_USAGE;
		let sessionsRead = 0;
		let done = 0;
		await forEachLimited(sessions, SCAN_CONCURRENCY, async session => {
			if (token.isCancellationRequested) {
				return;
			}
			const usage = await this.getUsage(session, token);
			done++;
			onProgress?.(done, sessions.length);
			// A session with no recorded tokens read fine and simply spent nothing
			// worth reporting; it should not inflate the "read" count either way.
			if (usage === EMPTY_USAGE) {
				return;
			}
			sessionsRead++;
			total = addUsage(total, usage);
			bySource.set(session.source, addUsage(bySource.get(session.source) ?? EMPTY_USAGE, usage));
		});
		return { total, bySource, sessionsRead, sessionsTotal: sessions.length };
	}

	async deleteSession(session: IKinguVaultSession): Promise<void> {
		// The same question discovery asked, asked again: a path no scan would list
		// is a path this cannot delete, whatever handed it here.
		const source = vaultSource(session.source);
		if (session.rootRelativeSegments.length === 0 || !isDiscoverable(source, session.rootRelativeSegments)) {
			throw new Error(`Refusing to delete ${session.resource.path}: no scan of ${session.source} would have surfaced it`);
		}
		// The turns file and the workers' transcripts belong to this session and
		// have no meaning without it, so they go with it rather than being left as
		// orphans the next scan cannot explain.
		const alsoDelete: URI[] = [];
		if (session.contentResource) {
			alsoDelete.push(session.contentResource);
		}
		const subagents = subagentsDirectoryFor(session.resource.path);
		if (subagents) {
			alsoDelete.push(session.resource.with({ path: subagents }));
		}
		await this._fileService.del(session.resource, { useTrash: true });
		for (const resource of alsoDelete) {
			try {
				await this._fileService.del(resource, { useTrash: true, recursive: true });
			} catch {
				// Absent for most sessions; the one that mattered is already gone.
			}
		}
		// The description outlives invalidation by design, so a deletion has to say
		// so explicitly — otherwise a new transcript written to the freed path
		// within the filesystem's mtime resolution would inherit this one's title.
		this._descriptions.invalidate(session.resource.toString());
		this.invalidate();
	}

	private _contentResource(resource: URI, source: IKinguVaultSourceDefinition): URI | undefined {
		const path = source.contentPath?.(resource.path);
		return path ? resource.with({ path }) : undefined;
	}

	/** A session we could not read the body of still belongs in the list. */
	private _nameOnly(resource: URI, source: IKinguVaultSourceDefinition, contentResource: URI | undefined, workingDirectory: string | undefined, modified: number, relativeSegments: readonly string[], hostLabel: string | undefined): IKinguVaultSession {
		return {
			hostLabel,
			id: sessionId(source.id, resource),
			source: source.id,
			sourceLabel: source.label,
			rootRelativeSegments: relativeSegments,
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

/**
 * A session's identity.
 *
 * The authority is part of it because the same path exists on every machine:
 * two hosts both running an agent out of `/home/dev` would otherwise collide
 * and the vault would list one of them. It is empty for a local `file:` URI, so
 * a local id is just the path it always was.
 */
function sessionId(source: KinguVaultSource, resource: URI): string {
	return `${source}:${resource.authority}${resource.path}`;
}

function joinPath(base: URI, ...segments: string[]): URI {
	return base.with({ path: `${base.path.replace(/\/+$/, '')}/${segments.join('/')}` });
}

function basename(resource: URI): string {
	return pathSegments(resource.path).at(-1) ?? resource.path;
}
