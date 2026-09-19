/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileType, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import {
	decodeClaudeProjectDirName,
	findExcerpt,
	IKinguVaultSearchResult,
	IKinguVaultService,
	IKinguVaultSession,
	KinguVaultSource,
	readFirstUserPrompt,
	readRecordedTitle,
	readWorkingDirectory,
	sessionTitle,
} from '../common/kinguVault.js';

/**
 * How many transcripts are opened at once during a scan.
 *
 * A heavy user has thousands, and reading them all in parallel starves the file
 * service that the rest of the window shares. The scan is background work; it
 * may take a moment.
 */
const SCAN_CONCURRENCY = 8;

/**
 * How much of a transcript is read to describe it.
 *
 * Everything that names a session sits at the top: Claude writes its title on the
 * first line, and the opening prompt follows within a few records. A long-running
 * session's transcript runs to tens of megabytes, so reading them whole to pull
 * one line out of the head made the scan cost scale with how much work the user
 * had done — which is exactly backwards.
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
 * The index is held in memory and rebuilt on demand rather than persisted. These
 * files are the user's own working history, and a cache of their prompts on disk
 * is a copy of something private that they never asked us to make.
 */
export class KinguVaultService extends Disposable implements IKinguVaultService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private _sessions: Promise<readonly IKinguVaultSession[]> | undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	getSessions(token = CancellationToken.None): Promise<readonly IKinguVaultSession[]> {
		// Cached as the promise rather than its result so concurrent callers share
		// one scan instead of each starting their own.
		this._sessions ??= this._scan(token);
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
			const transcript = await this._readTranscript(session.resource, MAX_SEARCH_BYTES);
			const excerpt = transcript && findExcerpt(transcript, trimmed);
			if (excerpt) {
				results.push({ session, excerpt });
			}
		});
		// Re-sorted because the bounded walk completes out of order.
		return results.sort((a, b) => b.session.modified - a.session.modified);
	}

	private async _scan(token: CancellationToken): Promise<readonly IKinguVaultSession[]> {
		const home = await this._pathService.userHome();
		const sessions: IKinguVaultSession[] = [];
		try {
			sessions.push(...await this._scanClaude(home, token));
			sessions.push(...await this._scanCodex(home, token));
		} catch (error) {
			// A vault that cannot be read is an empty vault, not a broken window.
			this._logService.warn('[Kingu] vault scan failed', error);
		}
		return sessions.sort((a, b) => b.modified - a.modified);
	}

	/** `~/.claude/projects/<encoded working directory>/<session id>.jsonl` */
	private async _scanClaude(home: URI, token: CancellationToken): Promise<IKinguVaultSession[]> {
		const root = joinPath(home, '.claude', 'projects');
		const projects = await this._children(root);
		const sessions: IKinguVaultSession[] = [];
		for (const project of projects) {
			if (token.isCancellationRequested) {
				break;
			}
			if (project.type !== FileType.Directory) {
				continue;
			}
			// The directory name is the only place the working directory survives:
			// a transcript that never reached a record carrying `cwd` still has it.
			const fromDirName = decodeClaudeProjectDirName(project.name);
			const transcripts = await this._children(joinPath(root, project.name));
			await forEachLimited(transcripts, SCAN_CONCURRENCY, async entry => {
				if (token.isCancellationRequested || entry.type === FileType.Directory || !entry.name.endsWith('.jsonl')) {
					return;
				}
				const session = await this._describe(joinPath(root, project.name, entry.name), KinguVaultSource.Claude, fromDirName);
				if (session) {
					sessions.push(session);
				}
			});
		}
		return sessions;
	}

	/** `~/.codex/sessions/**\/rollout-*.jsonl`, bucketed by date rather than by project. */
	private async _scanCodex(home: URI, token: CancellationToken): Promise<IKinguVaultSession[]> {
		const root = joinPath(home, '.codex', 'sessions');
		const sessions: IKinguVaultSession[] = [];
		const transcripts = await this._findTranscripts(root, 4, token);
		await forEachLimited(transcripts, SCAN_CONCURRENCY, async resource => {
			if (token.isCancellationRequested) {
				return;
			}
			const session = await this._describe(resource, KinguVaultSource.Codex, undefined);
			if (session) {
				sessions.push(session);
			}
		});
		return sessions;
	}

	/**
	 * Every `.jsonl` under `root`, to a bounded depth.
	 *
	 * Bounded because the date buckets are the only nesting these layouts use, and
	 * an unbounded walk of a directory the user controls is a way to spend the
	 * whole scan inside one symlinked tree.
	 */
	private async _findTranscripts(root: URI, depth: number, token: CancellationToken): Promise<URI[]> {
		if (depth < 0 || token.isCancellationRequested) {
			return [];
		}
		const found: URI[] = [];
		for (const entry of await this._children(root)) {
			const resource = joinPath(root, entry.name);
			if (entry.type === FileType.Directory) {
				found.push(...await this._findTranscripts(resource, depth - 1, token));
			} else if (entry.name.endsWith('.jsonl')) {
				found.push(resource);
			}
		}
		return found;
	}

	private async _describe(resource: URI, source: KinguVaultSource, workingDirectoryHint: string | undefined): Promise<IKinguVaultSession | undefined> {
		let modified: number;
		try {
			modified = (await this._fileService.stat(resource)).mtime ?? 0;
		} catch {
			return undefined;
		}
		const head = await this._readTranscript(resource, DESCRIBE_PREFIX_BYTES);
		if (head === undefined) {
			return this._nameOnly(resource, source, workingDirectoryHint, modified);
		}
		// The recorded title wins: it is what the session was eventually about,
		// whereas the opening prompt is only where it started.
		const name = readRecordedTitle(head) ?? readFirstUserPrompt(head);
		return {
			id: `${source}:${resource.path}`,
			source,
			resource,
			title: sessionTitle(name, basename(resource)),
			workingDirectory: readWorkingDirectory(head) ?? workingDirectoryHint,
			modified,
		};
	}

	/** A session we could not read the body of still belongs in the list. */
	private _nameOnly(resource: URI, source: KinguVaultSource, workingDirectory: string | undefined, modified: number): IKinguVaultSession {
		return {
			id: `${source}:${resource.path}`,
			source,
			resource,
			title: basename(resource),
			workingDirectory,
			modified,
		};
	}

	/** At most `length` bytes from the start of a transcript, or `undefined` if unreadable. */
	private async _readTranscript(resource: URI, length: number): Promise<string | undefined> {
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
	const path = resource.path;
	return path.slice(path.lastIndexOf('/') + 1);
}
