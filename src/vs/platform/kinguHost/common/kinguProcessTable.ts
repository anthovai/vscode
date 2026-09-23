/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** One process in a host-wide sweep. */
export interface IKinguProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly name: string;
	/** Resident bytes (the working set on Windows). */
	readonly memory: number;
	/** CPU in percent of one core, when the platform reports it directly. */
	readonly cpu?: number;
	/** Cumulative CPU time in 100ns units (Windows), from which CPU is derived between sweeps. */
	readonly cpuTime?: number;
}

/**
 * The PowerShell sweep the ADE's `windows-process-resource-collector` makes,
 * one comma-separated row per process: pid, parent, working set, kernel plus
 * user time, name (last, because a name may contain a comma).
 */
export const WINDOWS_PROCESS_TABLE_SCRIPT = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name | ForEach-Object { "{0},{1},{2},{3},{4}" -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime),$_.Name }';

export function parseWindowsProcessTable(stdout: string): IKinguProcessRow[] {
	const rows: IKinguProcessRow[] = [];
	for (const line of stdout.split('\n')) {
		const match = /^\s*(?<pid>\d+),(?<ppid>\d+),(?<memory>\d*),(?<time>\d*),(?<name>.*?)\s*$/.exec(line);
		if (!match?.groups) {
			continue;
		}
		rows.push({
			pid: Number(match.groups.pid),
			ppid: Number(match.groups.ppid),
			memory: Number(match.groups.memory || 0),
			cpuTime: Number(match.groups.time || 0),
			name: match.groups.name,
		});
	}
	return rows;
}

/**
 * CPU for each process from two sweeps, as the ADE derives it on Windows: the
 * CPU time spent between them over the wall time between them, in percent of
 * one core. A process new since the last sweep, or a first sweep, reads 0.
 */
export function cpuBetweenSweeps(previous: ReadonlyMap<number, number> | undefined, current: readonly IKinguProcessRow[], elapsedMs: number): Map<number, number> {
	const cpu = new Map<number, number>();
	for (const row of current) {
		const before = previous?.get(row.pid);
		if (before === undefined || row.cpuTime === undefined || elapsedMs <= 0 || row.cpuTime < before) {
			cpu.set(row.pid, 0);
			continue;
		}
		// 100ns units → ms, over the elapsed ms, as a percentage.
		cpu.set(row.pid, ((row.cpuTime - before) / 10_000) / elapsedMs * 100);
	}
	return cpu;
}

/** Every process at or below `root`. */
export function processSubtree(rows: readonly IKinguProcessRow[], root: number): Set<number> {
	const children = new Map<number, number[]>();
	for (const row of rows) {
		if (row.pid === row.ppid) {
			continue;
		}
		const list = children.get(row.ppid) ?? [];
		list.push(row.pid);
		children.set(row.ppid, list);
	}
	const found = new Set<number>();
	if (!rows.some(row => row.pid === root)) {
		return found;
	}
	const pending = [root];
	while (pending.length > 0) {
		const pid = pending.pop()!;
		if (found.has(pid)) {
			continue;
		}
		found.add(pid);
		pending.push(...(children.get(pid) ?? []));
	}
	return found;
}
