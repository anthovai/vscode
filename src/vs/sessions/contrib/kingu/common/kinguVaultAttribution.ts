/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** What a session's working directory turned out to belong to. */
export const enum KinguProjectKind {
	/** A git repository's main checkout. */
	Repository = 'repository',
	/**
	 * A linked worktree of a repository.
	 *
	 * Worth its own kind rather than being folded into the repository: an agent
	 * running in a worktree is usually doing one task, and "what did that branch
	 * cost" is the question worktrees exist to make askable.
	 */
	Worktree = 'worktree',
	/** A directory that is not in a repository at all. */
	Directory = 'directory',
	/** A session whose transcript recorded no working directory. */
	Unattributed = 'unattributed',
}

/** Where a session ran, as something that can be totalled. */
export interface IKinguProject {
	/** Stable across a scan, and unique per machine: the host and the path. */
	readonly id: string;
	/** What to call it in a report. */
	readonly label: string;
	readonly kind: KinguProjectKind;
	/** The directory the attribution resolved to, absent when there was none. */
	readonly path: string | undefined;
	/** The machine, when it is not this one. */
	readonly hostLabel: string | undefined;
	/**
	 * The repository a worktree belongs to, when that is known.
	 *
	 * A worktree's `.git` file points at the repository that owns it, so a
	 * report can group `feature-x` under the repository it came off rather than
	 * stranding it beside unrelated directories.
	 */
	readonly repositoryPath?: string;
}

/** The project a session with no recorded working directory falls into. */
export function unattributedProject(hostLabel: string | undefined): IKinguProject {
	return {
		id: `${hostLabel ?? ''}\u0000?`,
		// Named rather than blank: a report with a row of sessions and no label
		// reads as a rendering bug instead of as "these did not say where they ran".
		label: 'No working directory',
		kind: KinguProjectKind.Unattributed,
		path: undefined,
		hostLabel,
	};
}

/**
 * The project for a resolved directory.
 *
 * `repositoryRoot` is the nearest ancestor holding a `.git`; `worktreeOf` is the
 * repository that `.git` pointed at when it was a file rather than a directory,
 * which is exactly how git distinguishes a linked worktree from a checkout.
 */
export function projectFor(options: {
	readonly workingDirectory: string;
	readonly hostLabel: string | undefined;
	readonly repositoryRoot: string | undefined;
	readonly worktreeOf: string | undefined;
}): IKinguProject {
	const { hostLabel, repositoryRoot, worktreeOf } = options;
	if (repositoryRoot === undefined) {
		// Not in a repository. The directory itself is the finest attribution
		// available, and inventing a coarser one by taking its parent would put
		// two unrelated projects in the same row.
		return {
			id: projectId(hostLabel, options.workingDirectory),
			label: basename(options.workingDirectory),
			kind: KinguProjectKind.Directory,
			path: options.workingDirectory,
			hostLabel,
		};
	}
	if (worktreeOf !== undefined) {
		return {
			id: projectId(hostLabel, repositoryRoot),
			// The repository's name and the worktree's, because a worktree is named
			// after its branch and `feature-x` alone does not say whose.
			label: `${basename(worktreeOf)} · ${basename(repositoryRoot)}`,
			kind: KinguProjectKind.Worktree,
			path: repositoryRoot,
			hostLabel,
			repositoryPath: worktreeOf,
		};
	}
	return {
		id: projectId(hostLabel, repositoryRoot),
		label: basename(repositoryRoot),
		kind: KinguProjectKind.Repository,
		path: repositoryRoot,
		hostLabel,
	};
}

/**
 * The repository a worktree's `.git` file points at, or `undefined` when the
 * file is not one.
 *
 * A linked worktree's `.git` is a one-line file reading
 * `gitdir: /path/to/repo/.git/worktrees/<name>`. The repository is what sits
 * above `.git`, so the pointer is cut at that segment rather than at a fixed
 * number of levels — a bare repository nests them differently.
 */
export function readWorktreeRepository(gitFileContent: string): string | undefined {
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(gitFileContent);
	if (!match) {
		return undefined;
	}
	const pointer = match[1].replace(/\\/g, '/');
	const worktrees = pointer.lastIndexOf('/.git/worktrees/');
	if (worktrees === -1) {
		return undefined;
	}
	return pointer.slice(0, worktrees);
}

/** The host and the path, so the same path on two machines is two projects. */
function projectId(hostLabel: string | undefined, path: string): string {
	return `${hostLabel ?? ''}\u0000${path}`;
}

/** The last segment of a path, whichever separator it uses. */
export function basename(path: string): string {
	const segments = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
	return segments[segments.length - 1] || path;
}

/** Every ancestor of `path`, nearest first, including `path` itself. */
export function ancestorDirectories(path: string, maxDepth: number): string[] {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const ancestors: string[] = [];
	let current = normalized;
	while (current && ancestors.length < maxDepth) {
		ancestors.push(current);
		const cut = current.lastIndexOf('/');
		// Stops at the root — `/` on posix, `C:` on Windows — rather than walking
		// past it into an empty string that would resolve as the current directory.
		if (cut <= 0 || /^[A-Za-z]:$/.test(current.slice(0, cut))) {
			break;
		}
		current = current.slice(0, cut);
	}
	return ancestors;
}
