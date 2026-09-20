/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { agentHostAuthority, toAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';

/** A machine whose agent transcripts the vault reads. */
export interface IKinguVaultHost {
	/** The home directory to walk, as the file service addresses it. */
	readonly home: URI;
	/**
	 * What to call the machine in the list.
	 *
	 * `undefined` for this one: a vault that labelled every local session "this
	 * computer" would be labelling the default, and the point of the label is to
	 * mark the sessions that are somewhere else.
	 */
	readonly label: string | undefined;
}

/** The shape of a remote connection this needs, which is less than the registry's. */
export interface IKinguRemoteHostCandidate {
	readonly address: string;
	readonly name: string;
	/** The host's home directory, as the host itself reported it. */
	readonly defaultDirectory?: string;
	readonly status: { readonly kind: string };
}

/**
 * The connected remote hosts, as homes the vault can walk.
 *
 * Nothing new is dialled to produce this. A remote host is scanned only while
 * this window already holds a live connection to it, because the alternative —
 * opening one to read a file listing — would mean the vault silently starting
 * SSH sessions on machines the user had merely configured once.
 *
 * The walk itself needs no remote code: a connected host already serves its
 * filesystem to `IFileService` under the agent-host scheme, so the same source
 * table, the same parsers and the same bounded reads that describe a local
 * transcript describe a remote one. Only the root differs.
 */
export function remoteVaultHosts(connections: readonly IKinguRemoteHostCandidate[]): IKinguVaultHost[] {
	const hosts: IKinguVaultHost[] = [];
	const seen = new Set<string>();
	for (const connection of connections) {
		if (connection.status.kind !== 'connected') {
			continue;
		}
		// A host that has not reported its home is skipped rather than guessed at:
		// `/root`, `/home/<user>` and `C:\Users\<user>` are all plausible and a
		// wrong guess would walk someone else's directory.
		const home = remoteHomeUri(connection.address, connection.defaultDirectory);
		if (!home || seen.has(home.toString())) {
			continue;
		}
		seen.add(home.toString());
		hosts.push({ home, label: connection.name || connection.address });
	}
	return hosts;
}

/** One host's home as an agent-host URI, or `undefined` when it named none. */
export function remoteHomeUri(address: string, defaultDirectory: string | undefined): URI | undefined {
	const trimmed = defaultDirectory?.trim().replace(/[\\/]+$/, '');
	if (!trimmed) {
		return undefined;
	}
	// The path is the host's own, so it is kept verbatim and only given the
	// leading slash a URI path needs — which a Windows host's `C:\Users\me` lacks.
	const path = trimmed.replace(/\\/g, '/');
	return toAgentHostUri(URI.from({ scheme: 'file', path: path.startsWith('/') ? path : `/${path}` }), agentHostAuthority(address));
}
