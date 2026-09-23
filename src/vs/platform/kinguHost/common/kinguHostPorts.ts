/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** A TCP port a process on this machine is accepting connections on. */
export interface IKinguListeningPort {
	readonly port: number;
	/** The address it is bound to, as the platform reported it. */
	readonly address: string;
	/** The owning process, when the platform's listing names one. */
	readonly pid: number | undefined;
	/**
	 * What that process is, as the machine names it.
	 *
	 * Filled in from the app's own process tree rather than from the socket
	 * listing, because "3000 node" answers "is that mine, and which one" and a
	 * bare 3000 does not.
	 */
	readonly process?: string;
}

/**
 * Whether a listening socket is one a person would call "a port I am running".
 *
 * Loopback and wildcard binds are; a socket bound to one routable address is
 * something else on the network that this machine merely holds an end of. The
 * ephemeral range is dropped for the same reason: those are outbound
 * machinery, not servers.
 */
export function isInterestingPort(entry: IKinguListeningPort): boolean {
	if (!Number.isInteger(entry.port) || entry.port <= 0 || entry.port >= 49152) {
		return false;
	}
	const address = entry.address;
	return address === '0.0.0.0' || address === '::' || address === '*'
		|| address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

/**
 * The ports worth showing, lowest first.
 *
 * `owned` is the app's own process tree. Only its ports survive, because the
 * question the strip answers is "what have my agents started", not "what is
 * this operating system running" — on a Windows machine the second is thirty
 * entries of system services and reading it would teach the user to ignore the
 * number. A port whose owner the platform did not name cannot be attributed,
 * so it is left out rather than counted on a guess.
 */
export function normalizeListeningPorts(entries: readonly IKinguListeningPort[], owned: ReadonlySet<number>): IKinguListeningPort[] {
	const byPort = new Map<number, IKinguListeningPort>();
	for (const entry of entries) {
		if (!isInterestingPort(entry) || entry.pid === undefined || !owned.has(entry.pid)) {
			continue;
		}
		// The same server listening on v4 and v6 is one port, not two.
		if (!byPort.has(entry.port)) {
			byPort.set(entry.port, entry);
		}
	}
	return [...byPort.values()].sort((left, right) => left.port - right.port);
}

/**
 * The ADE's split of listening ports: the ones this app's own processes hold
 * (its "workspace" ports, counted on the footer), and every other interesting
 * port on the machine (its "external" ones, listed but not counted).
 *
 * The ADE attributes a port to a workspace by the owning process's working
 * directory or command line; here the question is the one this app can answer
 * exactly - is the owner one of its descendants - which is what "a port my
 * agents started" means in this window.
 */
export interface IKinguPortScan {
	readonly workspace: readonly IKinguListeningPort[];
	readonly external: readonly IKinguListeningPort[];
}

/** Splits interesting ports into the app's own and everything else, one row per port, lowest first. */
export function classifyListeningPorts(entries: readonly IKinguListeningPort[], owned: ReadonlySet<number>): IKinguPortScan {
	const workspace = new Map<number, IKinguListeningPort>();
	const external = new Map<number, IKinguListeningPort>();
	for (const entry of entries) {
		if (!isInterestingPort(entry)) {
			continue;
		}
		const target = entry.pid !== undefined && owned.has(entry.pid) ? workspace : external;
		if (!target.has(entry.port)) {
			target.set(entry.port, entry);
		}
	}
	for (const port of workspace.keys()) {
		external.delete(port);
	}
	const sorted = (ports: Map<number, IKinguListeningPort>) => [...ports.values()].sort((left, right) => left.port - right.port);
	return { workspace: sorted(workspace), external: sorted(external) };
}

/** A request to stop the process holding a port, as the ADE's `workspacePorts:kill` takes it. */
export interface IKinguStopPortRequest {
	readonly pid: number;
	readonly port: number;
}

export type KinguStopPortResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether a stop request may go ahead, checked against a fresh scan - the
 * ADE's rules, in its order. The caller's pid is never trusted on its own: the
 * port must still be listening, held by that pid, and held by one of this
 * app's descendants that is not the app itself.
 */
export function checkStopPortRequest(request: IKinguStopPortRequest, scan: IKinguPortScan, appPids: ReadonlySet<number>): KinguStopPortResult {
	if (!Number.isSafeInteger(request.pid) || request.pid <= 0 || !Number.isSafeInteger(request.port)) {
		return { ok: false, reason: 'Invalid process or port.' };
	}
	const row = [...scan.workspace, ...scan.external].find(entry => entry.port === request.port && entry.pid === request.pid);
	if (!row) {
		return { ok: false, reason: 'The port is no longer listening.' };
	}
	if (!scan.workspace.includes(row)) {
		return { ok: false, reason: 'Only workspace-owned local processes can be stopped here.' };
	}
	if (appPids.has(request.pid)) {
		return { ok: false, reason: 'Kingu cannot stop its own process.' };
	}
	return { ok: true };
}

/** What a process and everything below it is using: CPU in percent of one core, memory in bytes. */
export interface IKinguProcessUsage {
	readonly pid: number;
	readonly cpu: number;
	readonly memory: number;
}

/** The ports with their owners' names attached, where the tree knows one. */
export function nameListeningPorts(ports: readonly IKinguListeningPort[], names: ReadonlyMap<number, string>): IKinguListeningPort[] {
	return ports.map(port => {
		const name = port.pid === undefined ? undefined : names.get(port.pid);
		return name ? { ...port, process: name } : port;
	});
}

/** A port as a row a person reads: `3000 node`, or just `3000`. */
export function describeListeningPort(port: IKinguListeningPort): string {
	return port.process ? `${port.port} ${port.process}` : String(port.port);
}

/**
 * `netstat -ano -p tcp` on Windows.
 *
 * Columns are `Proto Local Foreign State PID`. The header is localized but the
 * state is not, which is why the state is matched rather than the row position.
 */
export function parseNetstatPorts(stdout: string): IKinguListeningPort[] {
	const entries: IKinguListeningPort[] = [];
	for (const line of splitLines(stdout)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length < 5 || !/^TCP$/i.test(columns[0]) || !/^LISTENING$/i.test(columns[3])) {
			continue;
		}
		const bound = splitHostPort(columns[1]);
		if (bound) {
			entries.push({ ...bound, pid: positiveInteger(columns[4]) });
		}
	}
	return entries;
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN` on macOS.
 *
 * The bind is the NAME column and a dual-stack socket is written `*:3000`. The
 * state follows it as its own word, so it is dropped before the bind is read
 * rather than stripped off the end of it.
 */
export function parseLsofPorts(stdout: string): IKinguListeningPort[] {
	const entries: IKinguListeningPort[] = [];
	for (const line of splitLines(stdout)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length < 9 || /^COMMAND$/i.test(columns[0])) {
			continue;
		}
		const last = columns[columns.length - 1];
		const name = /^\(LISTEN\)$/i.test(last) ? columns[columns.length - 2] : last;
		const bound = splitHostPort(name);
		if (bound) {
			entries.push({ ...bound, pid: positiveInteger(columns[1]) });
		}
	}
	return entries;
}

/**
 * `ss -ltnpH` on Linux.
 *
 * Preferred over `/proc/net/tcp`, which names only an inode: with no process
 * behind a socket there is no way to tell a dev server this app started from
 * one of the machine's own services, and the count would be noise.
 *
 * Columns are `State Recv-Q Send-Q Local Peer [users]`, and the owner is
 * written `users:(("node",pid=1234,fd=20))`.
 */
export function parseSsPorts(stdout: string): IKinguListeningPort[] {
	const entries: IKinguListeningPort[] = [];
	for (const line of splitLines(stdout)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length < 4 || !/^LISTEN$/i.test(columns[0])) {
			continue;
		}
		const bound = splitHostPort(columns[3]);
		if (bound) {
			entries.push({ ...bound, pid: positiveInteger(/pid=(\d+)/.exec(line)?.[1]) });
		}
	}
	return entries;
}

function splitLines(stdout: string): string[] {
	return stdout.split('\n').map(line => line.replace(/\r$/, ''));
}

/** `host:port`, where the host may itself contain colons. */
function splitHostPort(value: string): { port: number; address: string } | undefined {
	const separator = value.lastIndexOf(':');
	if (separator <= 0) {
		return undefined;
	}
	const port = positiveInteger(value.slice(separator + 1));
	if (port === undefined) {
		return undefined;
	}
	// `[::]:3000` and `[::1]:3000` carry the brackets lsof and ss print.
	const address = value.slice(0, separator).replace(/^\[(.*)\]$/, '$1');
	return { port, address };
}

function positiveInteger(value: string | undefined): number | undefined {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
