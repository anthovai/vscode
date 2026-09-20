/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IKinguVaultSession } from './kinguVault.js';

/**
 * How many descriptions are kept.
 *
 * A description is a title, a working directory and a few counters — orders of
 * magnitude smaller than the transcript it was read out of, which is the thing
 * the cache exists to stop re-reading. A heavy user has a few thousand
 * sessions, so this holds all of them and the eviction below is a safety net
 * rather than the normal case.
 */
const MAX_ENTRIES = 8192;

/** What a description was read from, and therefore when it stops being true. */
export interface IKinguVaultFileStamp {
	readonly mtime: number;
	/** Absent when the file service did not report one; then mtime alone decides. */
	readonly size: number | undefined;
}

/**
 * What one scan saved and what it cost.
 *
 * Owned by the scan rather than by the cache. Several scans overlap routinely —
 * the window invalidates as WSL homes resolve and again as a host connects —
 * and a counter on the cache would be the sum of whichever of them happened to
 * be running, which is a number that means nothing.
 */
export interface IKinguVaultScanTally {
	/** Descriptions answered without opening the transcript. */
	reused: number;
	/** Transcripts actually read. */
	read: number;
}

export function createScanTally(): IKinguVaultScanTally {
	return { reused: 0, read: 0 };
}

/**
 * Remembers what each transcript was last described as.
 *
 * The scan is re-run whenever the window has reason to think the vault moved —
 * a host connecting, a manual refresh, a session being deleted — and without
 * this, every one of those re-reads the head of every transcript. Locally that
 * is wasteful; against a host reached over SSH it is the difference between a
 * list that appears and one that does not, because each of those reads is a
 * round trip rather than a page cache hit.
 *
 * A file is unchanged when its modification time and size both are. Size is
 * carried as well as mtime because a transcript is appended to: an editor
 * writing within a filesystem's mtime resolution changes the length, and a
 * length that has not moved either is as strong a statement as this can make
 * without reading the bytes it is trying to avoid reading.
 *
 * The entry is keyed by the full URI, so the same path on two hosts is two
 * entries and a description never crosses machines.
 *
 * Only a completed description is stored. A read that failed stays out, so a
 * host that was briefly unreachable cannot pin an empty answer for the rest of
 * the window's life.
 */
export class KinguVaultDescriptionCache {

	private readonly _entries = new Map<string, { stamp: IKinguVaultFileStamp; session: IKinguVaultSession }>();

	constructor(private readonly _maxEntries = MAX_ENTRIES) { }

	/** The description of `key`, if the file is provably the one it was read from. */
	get(key: string, stamp: IKinguVaultFileStamp, tally?: IKinguVaultScanTally): IKinguVaultSession | undefined {
		const entry = this._entries.get(key);
		if (!entry || !isUnchanged(entry.stamp, stamp)) {
			return undefined;
		}
		// Re-inserted so the map's own order is least-recently-used and eviction
		// takes the transcripts nobody has looked at.
		this._entries.delete(key);
		this._entries.set(key, entry);
		if (tally) {
			tally.reused++;
		}
		return entry.session;
	}

	set(key: string, stamp: IKinguVaultFileStamp, session: IKinguVaultSession, tally?: IKinguVaultScanTally): void {
		if (tally) {
			tally.read++;
		}
		this._entries.delete(key);
		this._entries.set(key, { stamp, session });
		if (this._entries.size > this._maxEntries) {
			const oldest = this._entries.keys().next();
			if (!oldest.done) {
				this._entries.delete(oldest.value);
			}
		}
	}

	/** Forgets one transcript, for a deletion this window performed itself. */
	invalidate(key: string): void {
		this._entries.delete(key);
	}

	clear(): void {
		this._entries.clear();
	}

	get size(): number {
		return this._entries.size;
	}
}

function isUnchanged(cached: IKinguVaultFileStamp, current: IKinguVaultFileStamp): boolean {
	if (cached.mtime !== current.mtime) {
		return false;
	}
	// A size neither side reported cannot disagree; one side reporting it and the
	// other not is a filesystem that changed its mind, which is not a match.
	return cached.size === current.size;
}
