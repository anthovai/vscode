/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Snap packs: the extensions a kind of work needs, installed together from
 * Snap's front page (`browser/kinguSnapPicks.ts`). Every id is on Open VSX,
 * Kingu's gallery (checked 2026-09-30).
 */
export interface IKinguSnapPack {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** A codicon id for the card. */
	readonly icon: string;
	readonly extensions: readonly string[];
	/**
	 * Files that say a workspace does this kind of work: a name at its root,
	 * or `name:text` for a file at its root that contains the text.
	 */
	readonly markers: readonly string[];
}

export const KINGU_SNAP_PACKS: readonly IKinguSnapPack[] = [
	{
		id: 'laravel',
		name: localize('kingu.snap.pack.laravel', "Laravel & PHP"),
		description: localize('kingu.snap.pack.laravel.description', "PHP intelligence, Blade, Pint formatting and Xdebug."),
		icon: 'server-process',
		extensions: ['bmewburn.vscode-intelephense-client', 'amiralizadeh9480.laravel-extra-intellisense', 'shufo.vscode-blade-formatter', 'open-southeners.laravel-pint', 'xdebug.php-debug'],
		markers: ['artisan', 'composer.json'],
	},
	{
		id: 'react',
		name: localize('kingu.snap.pack.react', "React & TypeScript"),
		description: localize('kingu.snap.pack.react.description', "Linting, formatting, Tailwind and React snippets."),
		icon: 'symbol-class',
		extensions: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode', 'bradlc.vscode-tailwindcss', 'dsznajder.es7-react-js-snippets', 'formulahendry.auto-rename-tag'],
		markers: ['package.json:"react"'],
	},
	{
		id: 'sveltekit',
		name: localize('kingu.snap.pack.sveltekit', "SvelteKit & Bun"),
		description: localize('kingu.snap.pack.sveltekit.description', "Kingu's own stack: Svelte, Bun, Tailwind and formatting."),
		icon: 'flame',
		extensions: ['svelte.svelte-vscode', 'oven.bun-vscode', 'bradlc.vscode-tailwindcss', 'esbenp.prettier-vscode', 'dbaeumer.vscode-eslint'],
		markers: ['svelte.config.js', 'svelte.config.ts', 'bun.lock', 'bun.lockb', 'package.json:"svelte"'],
	},
	{
		id: 'python',
		name: localize('kingu.snap.pack.python', "Python"),
		description: localize('kingu.snap.pack.python.description', "The language, the debugger and Ruff for linting and formatting."),
		icon: 'symbol-namespace',
		extensions: ['ms-python.python', 'ms-python.debugpy', 'charliermarsh.ruff'],
		markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'],
	},
	{
		id: 'go-rust',
		name: localize('kingu.snap.pack.goRust', "Go & Rust"),
		description: localize('kingu.snap.pack.goRust.description', "Both languages' servers and TOML for Cargo."),
		icon: 'gear',
		extensions: ['golang.Go', 'rust-lang.rust-analyzer', 'tamasfe.even-better-toml'],
		markers: ['go.mod', 'Cargo.toml'],
	},
	{
		id: 'devops',
		name: localize('kingu.snap.pack.devops', "DevOps & Data"),
		description: localize('kingu.snap.pack.devops.description', "Docker, YAML, .env files and SQL databases."),
		icon: 'server',
		extensions: ['ms-azuretools.vscode-docker', 'redhat.vscode-yaml', 'mikestead.dotenv', 'mtxr.sqltools'],
		markers: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
	},
	{
		id: 'essentials',
		name: localize('kingu.snap.pack.essentials', "Everyday essentials"),
		description: localize('kingu.snap.pack.essentials.description', "Git history, inline errors, spelling and Markdown."),
		icon: 'star-empty',
		extensions: ['eamodio.gitlens', 'mhutchie.git-graph', 'usernamehw.errorlens', 'streetsidesoftware.code-spell-checker', 'yzhang.markdown-all-in-one'],
		markers: [],
	},
];

/** Reads a file at the workspace root, `undefined` when there is none. */
export type KinguRootFileReader = (name: string) => Promise<string | undefined>;

/** The packs a workspace's root files point to, in the order of `KINGU_SNAP_PACKS`. */
export async function kinguPacksForWorkspace(readRootFile: KinguRootFileReader, packs: readonly IKinguSnapPack[] = KINGU_SNAP_PACKS): Promise<IKinguSnapPack[]> {
	const cache = new Map<string, Promise<string | undefined>>();
	const read = (name: string) => {
		let pending = cache.get(name);
		if (!pending) {
			pending = readRootFile(name);
			cache.set(name, pending);
		}
		return pending;
	};
	const matches: IKinguSnapPack[] = [];
	for (const pack of packs) {
		for (const marker of pack.markers) {
			const separator = marker.indexOf(':');
			const name = separator < 0 ? marker : marker.slice(0, separator);
			const text = separator < 0 ? undefined : marker.slice(separator + 1);
			const content = await read(name);
			if (content !== undefined && (text === undefined || content.includes(text))) {
				matches.push(pack);
				break;
			}
		}
	}
	return matches;
}

/** How many of a pack's extensions are installed, for the card's button. */
export function kinguPackProgress(pack: IKinguSnapPack, installedIds: ReadonlySet<string>): { readonly installed: number; readonly total: number } {
	return { installed: pack.extensions.filter(id => installedIds.has(id.toLowerCase())).length, total: pack.extensions.length };
}
