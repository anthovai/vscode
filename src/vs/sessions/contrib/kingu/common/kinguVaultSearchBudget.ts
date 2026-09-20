/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** The one thing grouping needs to know about a session. */
export interface IKinguVaultHosted {
	/** The machine it is on, or `undefined` for this one. */
	readonly hostLabel?: string;
}

/** What a search may spend against one machine. */
export interface IKinguSearchBudget {
	/** The most of one transcript that is read looking for a match. */
	readonly perSessionBytes: number;
	/** The most this machine is read in one search, across every transcript. */
	readonly totalBytes: number;
	/** How many transcripts are open against this machine at once. */
	readonly concurrency: number;
}

/**
 * This machine, where a read is a page cache hit.
 *
 * The per-session cap is high enough to cover an ordinary session whole, and
 * there is no total: the search is already bounded by how many sessions exist,
 * and adding a second bound would make a local search silently incomplete for
 * no gain.
 */
export const LOCAL_SEARCH_BUDGET: IKinguSearchBudget = {
	perSessionBytes: 8 * 1024 * 1024,
	totalBytes: Number.POSITIVE_INFINITY,
	concurrency: 8,
};

/**
 * A machine reached over the agent host connection, where a read is a round
 * trip on a link the agent is also using.
 *
 * Every number is smaller than the local one and for the same reason. The
 * per-session cap covers the opening of a long session rather than all of it,
 * which is where a searched phrase usually is; the total stops one search from
 * pulling a corpus across the wire; and the concurrency is low because these
 * reads queue behind the protocol the agent itself is talking.
 *
 * The honest consequence is that a remote search can miss a match that is deep
 * inside a very long transcript, which is why a search reports where it
 * stopped rather than presenting its results as the whole answer.
 */
export const REMOTE_SEARCH_BUDGET: IKinguSearchBudget = {
	perSessionBytes: 512 * 1024,
	totalBytes: 64 * 1024 * 1024,
	concurrency: 4,
};

export function searchBudgetFor(isRemote: boolean): IKinguSearchBudget {
	return isRemote ? REMOTE_SEARCH_BUDGET : LOCAL_SEARCH_BUDGET;
}

/**
 * One machine's remaining allowance.
 *
 * Asked before each read rather than measured after, so a host whose budget is
 * gone stops costing anything instead of overspending by one transcript per
 * worker in flight.
 */
export class KinguSearchLedger {

	private _spent = 0;

	constructor(readonly budget: IKinguSearchBudget) { }

	get spent(): number {
		return this._spent;
	}

	get exhausted(): boolean {
		return this._spent >= this.budget.totalBytes;
	}

	/**
	 * How much may be read from the next transcript, or `0` when nothing may.
	 *
	 * The whole per-session allowance is claimed up front. Claiming what was
	 * actually read would let a host with a hundred short transcripts left in
	 * its budget start a hundred reads that each turn out to be long.
	 */
	claim(): number {
		if (this.exhausted) {
			return 0;
		}
		const allowance = Math.min(this.budget.perSessionBytes, this.budget.totalBytes - this._spent);
		this._spent += allowance;
		return allowance;
	}

	/** Returns what a read did not use, so a corpus of short files is not cut short. */
	refund(claimed: number, used: number): void {
		this._spent -= Math.max(0, claimed - used);
	}
}

/**
 * The sessions grouped by the machine they are on, local first.
 *
 * Local first so that when a search is capped, the results it does return are
 * the ones from the machine the user is sitting at — which is where they are
 * most often looking.
 */
export function groupSearchByHost<T extends IKinguVaultHosted>(sessions: readonly T[]): Map<string | undefined, T[]> {
	const hosts = new Map<string | undefined, T[]>([[undefined, []]]);
	for (const session of sessions) {
		const existing = hosts.get(session.hostLabel);
		if (existing) {
			existing.push(session);
		} else {
			hosts.set(session.hostLabel, [session]);
		}
	}
	return hosts;
}
