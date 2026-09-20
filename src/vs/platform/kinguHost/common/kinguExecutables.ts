/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The file names a command could have on this platform, in the order a shell
 * would try them.
 *
 * On Windows a command is not a file name: `claude` on PATH is `claude.cmd`
 * far more often than `claude`, because that is what npm writes for a package
 * with a bin entry. Looking only for the bare name finds nothing and reports
 * every agent as absent.
 */
export function executableNames(platform: string, command: string): string[] {
	return platform === 'win32'
		? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]
		: [command];
}

/**
 * Where to look for an agent's CLI, nearest first.
 *
 * PATH comes first and decides, because it is what would actually run. The
 * directories after it are the places an installer puts a binary without
 * putting it on the PATH this process inherited — which is the normal case for
 * a desktop app on macOS and Linux, where a GUI process is started by the
 * session manager and never sees the login shell's PATH.
 *
 * A directory listed twice is looked in once, so a PATH that already contains
 * `~/.local/bin` does not make the fallback re-stat it.
 */
export function executableSearchDirectories(options: {
	readonly platform: string;
	readonly pathEnv: string | undefined;
	readonly home: string;
}): string[] {
	const separator = options.platform === 'win32' ? ';' : ':';
	const directories = (options.pathEnv ?? '').split(separator).map(entry => entry.trim()).filter(Boolean);
	directories.push(...installDirectories(options.platform, options.home));

	const seen = new Set<string>();
	return directories.filter(directory => {
		// Compared case-insensitively on Windows, where `C:\Bin` and `c:\bin` are
		// one directory and stating both is pure waste.
		const key = options.platform === 'win32' ? directory.toLowerCase() : directory;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/**
 * Where an agent's own installer puts its binary.
 *
 * Every entry here is a place a published install script writes to. There is
 * deliberately no guessing beyond that: a scan of arbitrary directories looking
 * for something named like an agent would be slow and would find the wrong
 * file eventually.
 */
function installDirectories(platform: string, home: string): string[] {
	const join = (...segments: string[]) => segments.join(platform === 'win32' ? '\\' : '/');
	if (platform === 'win32') {
		return [
			join(home, 'AppData', 'Roaming', 'npm'),
			join(home, '.bun', 'bin'),
			join(home, '.local', 'bin'),
		];
	}
	const directories = [
		'/usr/local/bin',
		join(home, '.local', 'bin'),
		join(home, '.bun', 'bin'),
		join(home, '.deno', 'bin'),
		// Each of these is one CLI's own installer default.
		join(home, '.opencode', 'bin'),
		join(home, '.codeium', 'bin'),
	];
	if (platform === 'darwin') {
		// Apple Silicon Homebrew. Intel Homebrew shares `/usr/local` above.
		directories.unshift('/opt/homebrew/bin');
	}
	if (platform === 'linux') {
		directories.push('/snap/bin', '/home/linuxbrew/.linuxbrew/bin');
	}
	directories.push(join(home, '.nix-profile', 'bin'));
	return directories;
}

/** How many directories are searched before giving up. */
export const MAX_SEARCH_DIRECTORIES = 256;

/** How many commands one request may ask about. */
export const MAX_COMMANDS_PER_REQUEST = 64;
