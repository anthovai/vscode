/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalProfileService } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { IShellEnvironmentService } from '../../../../workbench/services/environment/electron-browser/shellEnvironmentService.js';
import { IKinguVaultService, KinguVaultSource } from '../common/kinguVault.js';
import {
	IKinguVaultEnvironment,
	KINGU_VAULT_ROOT_OVERRIDES,
	registerKinguVaultEnvironmentSource,
	resolveRootOverride,
	wslDistroFromProfileName,
	wslDistroRoot,
} from '../common/kinguVaultEnvironment.js';

/**
 * Tells the vault where else to look, using the two things only the desktop
 * knows: the user's shell environment, and which WSL distributions exist.
 *
 * Both answers are cached for the window. A user does not install a
 * distribution or move an agent's home while the window is open often enough to
 * pay for re-resolving them on every scan, and "Refresh Vault" rebuilds this
 * along with the index.
 */
class KinguVaultEnvironmentContribution extends Disposable {

	static readonly ID = 'kingu.contrib.vaultEnvironment';

	private _resolved: Promise<IKinguVaultEnvironment> | undefined;

	constructor(
		@IShellEnvironmentService private readonly _shellEnvironmentService: IShellEnvironmentService,
		@ITerminalProfileService private readonly _terminalProfileService: ITerminalProfileService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IKinguVaultService private readonly _vaultService: IKinguVaultService,
	) {
		super();

		this._register(registerKinguVaultEnvironmentSource({
			resolve: () => {
				this._resolved ??= this._resolve();
				return this._resolved;
			},
		}));

		// The vault may already have scanned with the local home and the default
		// roots before this resolved. Dropping that index is the only way the extra
		// roots appear without the user asking again.
		void this._warmUp();
	}

	private async _warmUp(): Promise<void> {
		const environment = await this._resolved ?? await this._resolve();
		this._resolved = Promise.resolve(environment);
		if (environment.homeDirectories.length > 0 || environment.rootOverrides.size > 0) {
			this._vaultService.invalidate();
		}
	}

	private async _resolve(): Promise<IKinguVaultEnvironment> {
		const [homeDirectories, rootOverrides] = await Promise.all([
			this._wslHomeDirectories(),
			this._rootOverrides(),
		]);
		// Traced because both halves are invisible when they find nothing, and
		// "found nothing" and "never ran" look identical from the session list.
		this._logService.trace('[Kingu] vault environment:'
			+ ` ${homeDirectories.length} extra home(s) [${homeDirectories.map(home => home.fsPath).join(', ')}]`
			+ `, ${rootOverrides.size} moved root(s) [${Array.from(rootOverrides).map(([source, roots]) => `${source}=${roots.join(';')}`).join(', ')}]`);
		return { homeDirectories, rootOverrides };
	}

	/**
	 * The roots the user's environment moves, by source.
	 *
	 * The shell environment rather than this process's own: these variables are
	 * set in a shell profile, which the app only inherits when it was launched
	 * from a terminal.
	 */
	private async _rootOverrides(): Promise<ReadonlyMap<KinguVaultSource, readonly string[]>> {
		const overrides = new Map<KinguVaultSource, readonly string[]>();
		let environment;
		try {
			environment = await this._shellEnvironmentService.getShellEnv();
		} catch (error) {
			this._logService.warn('[Kingu] could not read the shell environment for vault roots', error);
			return overrides;
		}
		for (const [source, candidates] of KINGU_VAULT_ROOT_OVERRIDES) {
			const roots: string[] = [];
			for (const candidate of candidates) {
				const root = resolveRootOverride(candidate, environment[candidate.variable]);
				// The first variable a source lists that names an absolute directory
				// wins; the rest are the older spellings of the same setting.
				if (root) {
					roots.push(root);
					break;
				}
			}
			if (roots.length > 0) {
				overrides.set(source, roots);
			}
		}
		return overrides;
	}

	/**
	 * One home directory per user of each WSL distribution.
	 *
	 * The distribution names come from the terminal service, which already runs
	 * `wsl.exe` to build its profiles — the share root itself cannot be listed, so
	 * a name is the only way in. Each distribution's `/home` is then read for the
	 * users that actually exist rather than assuming the Windows account's name.
	 */
	private async _wslHomeDirectories(): Promise<readonly URI[]> {
		if (!isWindows) {
			return [];
		}
		const homes: URI[] = [];
		try {
			await this._terminalProfileService.profilesReady;
			const distros = new Set<string>();
			for (const profile of this._terminalProfileService.availableProfiles) {
				const distro = wslDistroFromProfileName(profile.profileName);
				if (distro) {
					distros.add(distro);
				}
			}
			for (const distro of distros) {
				homes.push(...await this._distroHomes(distro));
			}
		} catch (error) {
			this._logService.warn('[Kingu] could not enumerate WSL home directories', error);
		}
		return homes;
	}

	private async _distroHomes(distro: string): Promise<URI[]> {
		const root = wslDistroRoot(distro);
		const homes: URI[] = [];
		try {
			const users = await this._fileService.resolve(URI.file(`${root}/home`));
			for (const user of users.children ?? []) {
				if (user.isDirectory) {
					homes.push(user.resource);
				}
			}
		} catch {
			// A distribution that is not running, or has no /home, contributes none.
		}
		try {
			// root's own home is outside /home and is where a distribution used as a
			// throwaway sandbox keeps everything.
			const rootHome = await this._fileService.resolve(URI.file(`${root}/root`));
			if (rootHome.isDirectory) {
				homes.push(rootHome.resource);
			}
		} catch {
			// Usually refused rather than absent; either way there is nothing to add.
		}
		return homes;
	}
}

registerWorkbenchContribution2(KinguVaultEnvironmentContribution.ID, KinguVaultEnvironmentContribution, WorkbenchPhase.AfterRestored);
