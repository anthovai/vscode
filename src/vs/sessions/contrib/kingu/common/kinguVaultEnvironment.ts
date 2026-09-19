/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { KinguVaultSource } from './kinguVault.js';

/**
 * Where a source's root can be moved to, and by which environment variable.
 *
 * Agents let a user relocate their state, and a user who has done so has all of
 * their history there and none of it under the default root. The variable names
 * a directory; `suffix` is what the sessions live under inside it.
 */
export interface IKinguVaultRootOverride {
	readonly variable: string;
	readonly suffix: readonly string[];
	/**
	 * Whether the variable may name the agent's home, its agent directory or the
	 * sessions directory itself, with the last path segment deciding which.
	 * Only Pi and OMP spell it this way.
	 */
	readonly normalizeAgentDir?: '.pi' | '.omp';
}

/**
 * Every relocation the ADE's scanner honours, by the source it moves.
 *
 * Agents with no entry cannot be relocated by an environment variable.
 */
export const KINGU_VAULT_ROOT_OVERRIDES: ReadonlyMap<KinguVaultSource, readonly IKinguVaultRootOverride[]> = new Map([
	[KinguVaultSource.Codex, [{ variable: 'CODEX_HOME', suffix: ['sessions'] }]],
	[KinguVaultSource.Copilot, [{ variable: 'COPILOT_HOME', suffix: ['session-state'] }]],
	[KinguVaultSource.Grok, [{ variable: 'GROK_HOME', suffix: ['sessions'] }]],
	[KinguVaultSource.Kimi, [{ variable: 'KIMI_CODE_HOME', suffix: ['sessions'] }]],
	[KinguVaultSource.Devin, [{ variable: 'DEVIN_HOME', suffix: ['transcripts'] }]],
	[KinguVaultSource.OpenClaw, [{ variable: 'OPENCLAW_STATE_DIR', suffix: ['agents'] }]],
	// Names the sessions directory outright.
	[KinguVaultSource.Cline, [{ variable: 'CLINE_SESSION_DATA_DIR', suffix: [] }]],
	[KinguVaultSource.Pi, [{ variable: 'PI_CODING_AGENT_DIR', suffix: [], normalizeAgentDir: '.pi' }]],
	[KinguVaultSource.Omp, [{ variable: 'OMP_CODING_AGENT_DIR', suffix: [], normalizeAgentDir: '.omp' }]],
	// Prime Agent brands Pi's contract with its own prefix and adds a dedicated
	// sessions-root variable, which wins over the agent-directory one.
	[KinguVaultSource.PrimeAgent, [
		{ variable: 'PRIME_AGENT_SESSION_DIR', suffix: [] },
		{ variable: 'PRIME_AGENT_CODING_AGENT_SESSION_DIR', suffix: [] },
		{ variable: 'PRIME_AGENT_CODING_AGENT_DIR', suffix: ['sessions'] },
	]],
]);

/**
 * The directory an override names, or `undefined` when it names none usable.
 *
 * A relative value is dropped rather than resolved. It would resolve against the
 * reading process's working directory — which is not the one the agent's CLI had
 * when it wrote the variable — so it names a different directory in every
 * process that reads it. Syntactic only; this is not a containment check.
 */
export function resolveRootOverride(override: IKinguVaultRootOverride, value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || !isAbsolutePath(trimmed)) {
		return undefined;
	}
	const base = override.normalizeAgentDir
		? normalizeAgentSessionsDir(trimmed, override.normalizeAgentDir)
		: trimmed;
	return override.suffix.length > 0 ? joinSegments(base, override.suffix) : base;
}

/**
 * Where Pi and OMP keep sessions, given a variable that may name any level of
 * the tree. The last segment says which level was meant; anything else is taken
 * at face value.
 */
export function normalizeAgentSessionsDir(value: string, agentHomeDirName: '.pi' | '.omp'): string {
	const normalized = value.replace(/[\\/]+$/, '');
	const leaf = normalized.split(/[\\/]/).pop() ?? '';
	if (leaf === 'sessions') {
		return normalized;
	}
	if (leaf === 'agent') {
		return joinSegments(normalized, ['sessions']);
	}
	if (leaf === agentHomeDirName) {
		return joinSegments(normalized, ['agent', 'sessions']);
	}
	return normalized;
}

function isAbsolutePath(value: string): boolean {
	// Posix, a Windows drive, or a UNC share — the last being how a WSL root is
	// named from the host side.
	return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function joinSegments(base: string, segments: readonly string[]): string {
	const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	return base.replace(/[\\/]+$/, '') + separator + segments.join(separator);
}

/**
 * What the host can tell the vault about where else to look.
 *
 * Resolved outside the scanner because both halves need the desktop: the shell
 * environment is not readable from a sandboxed renderer, and WSL distributions
 * are named by the terminal service rather than by anything on disk.
 */
export interface IKinguVaultEnvironment {
	/**
	 * Home directories to scan besides the user's own — one per WSL distribution
	 * user. An agent installed inside a distribution writes its history there and
	 * nowhere the Windows side can see by default.
	 */
	readonly homeDirectories: readonly URI[];
	/** Absolute roots named by environment variables, by the source they move. */
	readonly rootOverrides: ReadonlyMap<KinguVaultSource, readonly string[]>;
}

export interface IKinguVaultEnvironmentSource {
	/** Resolves once per scan. Failures are the provider's to swallow. */
	resolve(): Promise<IKinguVaultEnvironment>;
}

let environmentSource: IKinguVaultEnvironmentSource | undefined;

/**
 * Publishes the host's answer to the scanner.
 *
 * A registry rather than a service dependency because the scanner runs in every
 * layer and this is only answerable on the desktop; where nothing registers,
 * the vault reads the local home and the default roots, which is correct.
 */
export function registerKinguVaultEnvironmentSource(source: IKinguVaultEnvironmentSource): IDisposable {
	environmentSource = source;
	return toDisposable(() => {
		if (environmentSource === source) {
			environmentSource = undefined;
		}
	});
}

export function getKinguVaultEnvironmentSource(): IKinguVaultEnvironmentSource | undefined {
	return environmentSource;
}

/** The distribution a terminal profile names, or `undefined` when it names none. */
export function wslDistroFromProfileName(profileName: string): string | undefined {
	const match = /^(.+) \(WSL\)$/.exec(profileName.trim());
	const distro = match?.[1]?.trim();
	// Docker Desktop's distributions are an implementation detail of Docker and
	// hold no agent history, matching how the terminal service hides them.
	return distro && !distro.startsWith('docker-desktop') ? distro : undefined;
}

/** The host-side path to a WSL distribution's file system. */
export function wslDistroRoot(distro: string): string {
	return `//wsl.localhost/${distro}`;
}
