/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, session, WebContents, WebContentsView } from 'electron';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, extname, join, sep } from '../../../base/common/path.js';

/**
 * Runs the vendored ADE's UI inside the Agents Window.
 *
 * Not a second process, not a web view onto a server, and not a window of its
 * own: the ADE's main-process services come up in *this* main process, and its
 * renderer is a `WebContentsView` filling the Agents Window below the fork's
 * own title bar.
 *
 * **Why the title bar stays the fork's.** It is already what connects this
 * window to the IDE — back and forward, the session title, run, *Open in IDE*,
 * the panel toggles — and it carries the only set of window controls. Letting
 * the ADE draw its own title bar too is what gave the first attempt two sets of
 * window buttons.
 *
 * **Why a view rather than a window.** The ADE reaches for its window in
 * exactly two ways — `webContents` and `isDestroyed` — so what it is handed
 * does not have to be a `BrowserWindow`. The shim in {@link attach} is those
 * two members over the view, which is what lets the ADE's services push to the
 * ADE's renderer while the window itself belongs to the fork.
 *
 * Startup order matters and is not obvious:
 *
 * 1. `setMainWindowOpener` and `runMainProcessPreflight` must run **before**
 *    Electron is ready — preflight initializes the browser process user agent,
 *    which Electron refuses to accept afterwards.
 * 2. `registerMainProcessIpcHandlers` registers about ten startup channels.
 * 3. `attachMainWindowCoreServices` registers the other ~690. The ADE calls it
 *    from inside its own window opener, so a host that supplies its own and
 *    stops there gets a renderer that mounts and then fails every call.
 * 4. `initializeMainProcessReady` brings the services up, and can only run once
 *    there is a host window to hand back.
 */

/**
 * The scheme the ADE's renderer is served over.
 *
 * Its own rather than the workbench's `vscode-file:`. That scheme serves the
 * HTML and then quietly declines its ES module graph — the document loads, the
 * script tag is there with the right URL, and nothing is ever fetched — so the
 * window stays blank with no error to read.
 *
 * It is declared in `src/main.ts`, in the fork's own
 * `registerSchemesAsPrivileged` call, because Electron accepts that call once
 * and ignores any later one. Registering it separately here left it insecure,
 * and an insecure origin has no `crypto.randomUUID` — which the ADE's store
 * calls while it is still evaluating, so the UI never mounted.
 */
export const ORCA_SCHEME = 'kingu-orca';

/** The flag that puts the ADE's UI in the Agents Window. */
export const ORCA_BOOT_ARG = '--orca';

export function isOrcaBoot(argv: readonly string[] = process.argv): boolean {
	return argv.includes(ORCA_BOOT_ARG);
}

/**
 * Whether this boot opens the Agents Window, which runs the ADE's engine with
 * no ADE renderer.
 *
 * Read from `process.argv` rather than the parsed arguments because this is
 * answered before the ESM bootstrap has run, which is the only point early
 * enough to beat Electron to `ready`.
 */
export function isAgentsBoot(argv: readonly string[] = process.argv): boolean {
	return argv.includes('--agents');
}

interface IOrcaStartup {
	setMainWindowOpener(opener: () => BrowserWindow): void;
	runMainProcessPreflight(options: { focusExistingWindow: () => void; requestDesktopActivation: (argv?: readonly string[]) => void }): boolean;
	registerMainProcessIpcHandlers(): void;
	overrideIpcHandler(channel: string, handler: (...args: unknown[]) => unknown): void;
	attachMainWindowCoreServices(window: { webContents: WebContents }, deps: {
		markExpectedRendererReload: (webContentsId: number) => void;
		recordRendererReload: (ignoreCache: boolean) => void;
	}): void;
	initializeMainProcessReady(options: {
		openMainWindow: () => BrowserWindow;
		handleMacAppActivation: () => void;
	}): Promise<void>;
	mainProcessState: { mainWindow: unknown };
	hasKinguHandler(channel: string): boolean;
	invokeKinguHandler(channel: string, event: unknown, args: readonly unknown[]): Promise<unknown>;
	getLinearStatus(): IOrcaProviderStatus;
	getJiraStatus(): IOrcaProviderStatus;
}

/**
 * What the ADE's task providers report about themselves.
 *
 * Deliberately narrower than what they return. Each provider has its own richer
 * status type, and copying those here would tie this module to four of the
 * ADE's shapes for the sake of fields nothing in the fork reads yet. Widen it
 * when a caller needs more.
 */
export interface IOrcaProviderStatus {
	readonly connected: boolean;
}

/**
 * A channel this application answers instead of the ADE.
 *
 * How the parts of the Agents Window that are already better stay in use: the
 * ADE's UI goes on calling the channel it always called, and the answer comes
 * from here. One channel at a time, with no change to the ADE's code.
 */
export interface IKinguOrcaOverride {
	readonly channel: string;
	readonly handle: (window: BrowserWindow, ...args: unknown[]) => unknown;
	/** Why this application answers it better. */
	readonly because: string;
}

/**
 * The overrides, in one list so the substitution is inspectable.
 *
 * Every entry is a claim that this application does something better than the
 * ADE does, and a claim that cannot be justified in one line does not belong
 * here.
 */
export const KINGU_ORCA_OVERRIDES: readonly IKinguOrcaOverride[] = [
	{
		channel: 'window:isMaximized',
		handle: window => !window.isDestroyed() && window.isMaximized(),
		because: 'The window is the fork\'s, so the fork is what knows. The ADE would be answering about a window it did not create.',
	},
];

let startup: IOrcaStartup | undefined;
let hostWindow: BrowserWindow | undefined;
let orcaView: WebContentsView | undefined;

/**
 * `out-kingu-orca`, beside the `out` this file is running from.
 *
 * No `FileAccess`: this module is imported by the bootstrap *before* the ESM
 * bootstrap has run, which is the only point early enough to beat Electron to
 * `ready`. `vs/base/common/path` is fine there — `src/main.ts` already imports
 * several `vs/base/common` modules at that stage — but anything reaching for app
 * paths or the network layer is not.
 */
function outDirectory(): string {
	// out/vs/platform/kinguOrca/electron-main → out
	return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'out-kingu-orca');
}

/** `kingu-orca/`, the vendored stand-in for the ADE's repository root. */
function vendoredRoot(): string {
	return join(dirname(outDirectory()), 'kingu-orca');
}

/**
 * The ADE's bundle, loaded once and shared.
 *
 * Exported because the merge's whole direction is other fork services calling
 * into the ADE, and every one of them must get *this* instance: the bundle
 * carries the ADE's live state — connected providers, running processes — so a
 * second `require` of the same path would hand out a second, empty program.
 */
export function loadOrcaStartup(): IOrcaStartup | undefined {
	return loadStartup();
}

function loadStartup(): IOrcaStartup | undefined {
	if (startup) {
		return startup;
	}
	try {
		// A CommonJS bundle loaded at runtime rather than imported: it is built by
		// `build-kingu-orca`, not by the fork's own compile, and must not be a
		// static dependency of a process that may never boot the ADE.
		startup = createRequire(import.meta.url)(join(outDirectory(), 'startup.cjs')) as IOrcaStartup;
		return startup;
	} catch (error) {
		console.error('[kingu-orca] could not load startup.cjs — run `npm run build-kingu-orca`', error);
		return undefined;
	}
}

/**
 * Everything the ADE needs done before Electron is ready.
 *
 * Called at module scope from `src/main.ts`, which is the only place early
 * enough: the bootstrap waits for `ready` before importing the electron-main
 * bundle, so a hook there is always too late for preflight.
 */
export function prepareOrcaBoot(): void {
	const orca = loadStartup();
	if (!orca) {
		return;
	}
	// The ADE resolves everything it starts by path — the daemon it forks, the
	// plugin host, its worker threads, its webview preloads — and its resources,
	// as `<app.getAppPath()>/out/main/<entry>.js` and `<app.getAppPath()>/resources/…`,
	// across ~15 resolvers, several of which read `electron.app` directly rather
	// than through its AppEnvironment port. Left alone, `getAppPath()` answers
	// with the fork's root, where none of that exists, and the first casualty is
	// the terminal daemon: every PTY silently falls back or fails. The vendored
	// tree *is* the ADE's repository root here — `resources/` is in it, and
	// `build-kingu-orca` writes the sidecar entries to `kingu-orca/out/main/` —
	// so one answer fixes every resolver at once. The fork's own code never
	// calls `app.getAppPath()`, so in this boot mode the property is the ADE's
	// to define.
	app.getAppPath = () => vendoredRoot();
	try {
		// The ADE asks for a window opener now and calls it later. By then the
		// fork's own window exists, and that is what gets handed back.
		orca.setMainWindowOpener(() => hostWindow!);
		orca.runMainProcessPreflight({
			focusExistingWindow: () => hostWindow?.focus(),
			requestDesktopActivation: () => hostWindow?.show(),
		});
		orca.registerMainProcessIpcHandlers();
	} catch (error) {
		console.error('[kingu-orca] pre-ready startup failed', error);
	}
}

/**
 * Opens the window and puts the ADE in it. Called once Electron is ready.
 *
 * The window is the ADE's: it draws its own title bar, so the native frame is
 * removed and the ADE's controls are the only ones. The workbench is not
 * started — it opens later, and only if asked, through *Open IDE*.
 */
export async function startOrca(): Promise<void> {
	if (!loadStartup()) {
		return;
	}
	const window = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 680,
		minHeight: 480,
		title: 'Kingu',
		show: true,
		// The renderer draws the title bar. Without these the OS draws one too and
		// the window gets two sets of window controls — the ADE's own window
		// factory carries the same three lines for the same reason.
		...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
		...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const } : {}),
		...(process.platform === 'linux' ? { frame: false } : {}),
		// Alt reveals it; it would otherwise cost a row above a title bar the
		// renderer has already drawn.
		autoHideMenuBar: true,
		// macOS swallows the app-activating click by default, so clicking back
		// into the window would otherwise take two.
		acceptFirstMouse: true,
		backgroundColor: '#0a0a0a',
	});
	hostWindow = window;
	window.on('closed', () => {
		if (hostWindow === window) {
			hostWindow = undefined;
		}
	});
	app.on('window-all-closed', () => app.quit());
	await attach(window);
}

async function attach(window: BrowserWindow): Promise<void> {
	const orca = loadStartup();
	if (!orca) {
		return;
	}
	const out = outDirectory();
	// A session of its own so the scheme handler cannot affect the workbench's,
	// and persisted so the ADE's own storage survives a restart.
	const orcaSession = session.fromPartition('persist:kingu-orca');
	try {
		orcaSession.protocol.handle(ORCA_SCHEME, async request => {
			const requested = decodeURIComponent(new URL(request.url).pathname);
			const root = join(out, 'renderer');
			const file = join(root, requested);
			// The bundle only ever asks for what it shipped with, but a scheme
			// handler that will read any path it is handed is a scheme handler
			// that will read `../../`.
			if (file !== root && !file.startsWith(root + sep)) {
				return new Response(null, { status: 403 });
			}
			try {
				// Read here rather than `net.fetch` a `file:` URL: the workbench
				// intercepts `file:` for the whole process and refuses it, which
				// surfaces only as `ERR_UNEXPECTED` on the view.
				const contents = await fs.readFile(file);
				return new Response(contents, {
					headers: {
						'content-type': contentType(file),
						// Every script and preload in the built HTML carries
						// `crossorigin`, so the scheme's CORS check applies to all
						// of them. Without this the document loads, its module
						// graph is refused, and the window is blank with nothing
						// fetched and no error on the page.
						'access-control-allow-origin': '*',
					},
				});
			} catch (error) {
				console.error(`[kingu-orca] serve failed ${request.url}`, error);
				return new Response(null, { status: 404 });
			}
		});
	} catch (error) {
		console.error('[kingu-orca] could not serve the renderer', error);
	}
	const view = new WebContentsView({
		webPreferences: {
			session: orcaSession,
			preload: join(out, 'preload.cjs'),
			// Both taken from the ADE's own window: its renderer is sandbox-clean
			// by design and tested for it, and `webviewTag` is what its browser
			// panes are built on — without it they silently do not render.
			sandbox: true,
			webviewTag: true,
			contextIsolation: true,
			// Read by the preload before first paint. Over IPC the answer would
			// arrive a frame late and the ADE would draw window buttons and then
			// remove them.
			additionalArguments: ['--kingu-hosted'],
		},
	});
	orcaView = view;
	window.contentView.addChildView(view);
	layoutOrcaView(window, view);
	window.on('resize', () => layoutOrcaView(window, view));

	// What the ADE is told its window is.
	//
	// A proxy over the real window rather than a hand-written shim. The ADE's
	// window-level calls — `on`, `show`, `focus` — should reach the real window
	// and do, unchanged. Only two members are answered differently, and both for
	// the same reason: this window's `webContents` is the workbench's renderer,
	// and every push the ADE makes has to arrive at the ADE's instead.
	//
	// The first attempt was a two-member object, on the strength of counting
	// `state.mainWindow.*` uses. That count missed the window being passed *into*
	// functions, one of which calls `mainWindow.on` — which is the failure mode a
	// proxy makes impossible rather than merely unlikely.
	const hostShim = new Proxy(window, {
		get(target, property, receiver) {
			if (property === 'webContents') {
				return view.webContents;
			}
			if (property === 'isDestroyed') {
				return () => view.webContents.isDestroyed();
			}
			const value = Reflect.get(target, property, receiver);
			// Bound to the real window: Electron's own methods reject a `this`
			// that is the proxy.
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});

	try {
		// The order is the ADE's own, and it is load-bearing:
		// `attachMainWindowCoreServices` refuses to run before the services exist
		// ("Main window services must be initialized before attaching"), and the
		// ADE satisfies that by attaching from inside the opener that
		// `initializeMainProcessReady` calls once they are up. So the attach
		// happens there, not before.
		await orca.initializeMainProcessReady({
			openMainWindow: () => {
				try {
					orca.attachMainWindowCoreServices(hostShim, {
						markExpectedRendererReload: () => { },
						recordRendererReload: () => { },
					});
				} catch (error) {
					console.error('[kingu-orca] could not attach core services', error);
				}
				return window;
			},
			handleMacAppActivation: () => window.show(),
		});
	} catch (error) {
		// The view is already placed; a service that failed to come up should not
		// take the window with it.
		console.error('[kingu-orca] ready-phase startup failed', error);
	}

	// After the opener has run, because that is what sets it to the real window.
	orca.mainProcessState.mainWindow = hostShim;
	applyOverrides(orca, window);
	registerHostBridge(orca);

	try {
		await view.webContents.loadURL(`${ORCA_SCHEME}://renderer/index.html`);
	} catch (error) {
		console.error('[kingu-orca] could not load the ADE renderer', error);
	}
}

/**
 * What to call each thing the bundle asks for.
 *
 * Enough for a vite build and no more. The type matters most for the module
 * graph: a `.js` served as anything else is refused by the module loader, which
 * is the failure that leaves the window blank with the script tag present and
 * nothing fetched.
 */
function contentType(file: string): string {
	switch (extname(file).toLowerCase()) {
		case '.html': return 'text/html';
		case '.js': case '.mjs': return 'text/javascript';
		case '.css': return 'text/css';
		case '.json': case '.map': return 'application/json';
		case '.svg': return 'image/svg+xml';
		case '.png': return 'image/png';
		case '.webp': return 'image/webp';
		case '.jpg': case '.jpeg': return 'image/jpeg';
		case '.gif': return 'image/gif';
		case '.woff2': return 'font/woff2';
		case '.woff': return 'font/woff';
		case '.ttf': return 'font/ttf';
		case '.wasm': return 'application/wasm';
		default: return 'application/octet-stream';
	}
}

/**
 * Fills the whole window.
 *
 * The ADE draws its own title bar, so there is nothing above it to leave room
 * for. An earlier arrangement reserved a strip for the workbench's title bar and
 * put the ADE underneath — one window with two title bars, two theme systems and
 * two sets of window controls, which is precisely what this does not do.
 */
function layoutOrcaView(window: BrowserWindow, view: WebContentsView): void {
	if (window.isDestroyed() || view.webContents.isDestroyed()) {
		return;
	}
	const { width, height } = window.getContentBounds();
	view.setBounds({ x: 0, y: 0, width, height });
}

/**
 * Takes the listed channels back from the ADE.
 *
 * After `attachMainWindowCoreServices`, not before: that registers the ADE's own
 * handler for every channel it owns, and one registered first would simply be
 * replaced. The registration happens on the ADE's side because the fork's
 * `validatedIpcMain` refuses any channel that is not `vscode:`-prefixed, and
 * none of the ADE's are.
 */
function applyOverrides(orca: IOrcaStartup, window: BrowserWindow): void {
	for (const override of KINGU_ORCA_OVERRIDES) {
		try {
			orca.overrideIpcHandler(override.channel, (...args) => override.handle(window, ...args));
		} catch (error) {
			console.error(`[kingu-orca] could not override ${override.channel}`, error);
		}
	}
}

/**
 * Tells the ADE's UI it is a guest.
 *
 * It has no concept of a host when it runs as its own application. On this
 * answer its title bar stands down: the window controls and the way back to the
 * IDE are the fork's title bar's job here, and drawing them twice is the defect
 * this arrangement exists to avoid.
 */
function registerHostBridge(orca: IOrcaStartup): void {
	try {
		orca.overrideIpcHandler('kingu:isHosted', () => true);
		orca.overrideIpcHandler('kingu:openIde', () => startWorkbench());
	} catch (error) {
		console.error('[kingu-orca] could not register the host bridge', error);
	}
}

let workbenchStarted = false;

/**
 * Starts the workbench in this process, on demand.
 *
 * Not a second process. The obvious implementation — relaunch without `--orca`
 * — cannot work: this instance holds the single-instance lock on the user data
 * directory, so the new one hands its command line over and exits, and in this
 * mode nothing on our side is listening for that handoff. The window never
 * appears and nothing says why.
 *
 * Importing the electron-main bundle runs `new CodeMain().main()` at module
 * scope, which is exactly what is wanted and why it is imported lazily: booting
 * with `--orca` deliberately never loads it, so no workbench window opens that
 * nobody asked for.
 */
function startWorkbench(): void {
	if (workbenchStarted) {
		return;
	}
	workbenchStarted = true;
	import('../../../code/electron-main/main.js').catch(error => {
		workbenchStarted = false;
		console.error('[kingu-orca] could not start the workbench', error);
	});
}

/**
 * A message the ADE pushed to what it believes is its renderer.
 *
 * With the engine running headless there is no ADE renderer, so its pushes —
 * a quota that changed, a setting another surface wrote, an update that became
 * available — are the only way the Agents Window learns what the ADE learned.
 */
export interface IOrcaPush {
	readonly channel: string;
	readonly args: readonly unknown[];
}

const pushListeners = new Set<(push: IOrcaPush) => void>();

/** Subscribes to the ADE's pushes. Returns the unsubscribe. */
export function onOrcaPush(listener: (push: IOrcaPush) => void): () => void {
	pushListeners.add(listener);
	return () => pushListeners.delete(listener);
}

let engine: Promise<BrowserWindow | undefined> | undefined;

/**
 * Runs the ADE's backend in this process, with no ADE UI.
 *
 * This is what makes the Agents Window *use* the ADE rather than copy it. Its
 * status bar, its settings and its pages call the ADE's own handlers — the same
 * code the ADE's renderer calls, with every side effect that call has — instead
 * of a second implementation that would have to be kept in step with the first
 * and would drift the day it was written.
 *
 * The ADE needs a main window: it hands its services a window to push to and
 * reads `event.sender` to know who asked. It gets a hidden one. Not the Agents
 * Window, because a real `webContents` is what its ~700 handlers were written
 * against, and a shim of one would be a guess at which of its members they use;
 * the last guess of that kind, counting `state.mainWindow.*` uses, missed a
 * window passed into a function that called `on`. A hidden window costs one
 * idle renderer and is right by construction. Its `send` is the one member
 * replaced, so every push lands in {@link onOrcaPush} instead of a page nobody
 * is looking at.
 *
 * Idempotent, and lazy: the first caller starts it, the rest wait on the same
 * start.
 */
export function startOrcaEngine(): Promise<BrowserWindow | undefined> {
	engine ??= bringUpEngine();
	return engine;
}

async function bringUpEngine(): Promise<BrowserWindow | undefined> {
	const orca = loadStartup();
	if (!orca) {
		return undefined;
	}
	const window = new BrowserWindow({
		show: false,
		width: 800,
		height: 600,
		webPreferences: { sandbox: true, contextIsolation: true },
	});
	const contents = window.webContents;
	contents.send = (channel: string, ...args: unknown[]) => {
		for (const listener of pushListeners) {
			try {
				listener({ channel, args });
			} catch (error) {
				console.error(`[kingu-orca] push listener failed on ${channel}`, error);
			}
		}
	};
	// Never shown. The ADE brings its window forward on a deep link, a second
	// instance or a notification click; here the window it would bring forward
	// is empty, so those calls do nothing and the Agents Window stays in front.
	const hidden = new Proxy(window, {
		get(target, property) {
			if (property === 'show' || property === 'focus' || property === 'showInactive' || property === 'restore' || property === 'maximize' || property === 'moveTop') {
				return () => { };
			}
			if (property === 'isVisible') {
				return () => false;
			}
			// The real window as `this`, not the proxy: Electron's native getters
			// (`webContents` first among them) refuse any other receiver, and say so
			// as "Object has been destroyed".
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	hostWindow = hidden;
	try {
		await orca.initializeMainProcessReady({
			openMainWindow: () => {
				try {
					orca.attachMainWindowCoreServices(hidden, {
						markExpectedRendererReload: () => { },
						recordRendererReload: () => { },
					});
				} catch (error) {
					console.error('[kingu-orca] could not attach core services', error);
				}
				return hidden;
			},
			handleMacAppActivation: () => { },
		});
	} catch (error) {
		console.error('[kingu-orca] headless engine startup failed', error);
	}
	orca.mainProcessState.mainWindow = hidden;
	return hidden;
}

/**
 * Calls one of the ADE's handlers from this process, as its renderer would.
 *
 * Starts the engine if it is not running. `event.sender` is the ADE's own main
 * window, because that is who its renderer's calls come from and some handlers
 * check.
 */
export async function invokeOrca(channel: string, args: readonly unknown[]): Promise<unknown> {
	const window = await startOrcaEngine();
	const orca = loadStartup();
	if (!window || !orca) {
		throw new Error('The Kingu engine is not available in this build — run `npm run build-kingu-orca`.');
	}
	if (!orca.hasKinguHandler(channel)) {
		throw new Error(`Kingu has no handler for ${channel}`);
	}
	const sender = window.webContents;
	return await orca.invokeKinguHandler(channel, { sender, senderFrame: sender.mainFrame, processId: sender.getProcessId(), frameId: sender.mainFrame.routingId }, args);
}

/** The ADE's renderer, for anything in this process that needs to reach it. */
export function orcaWebContents(): WebContents | undefined {
	return orcaView && !orcaView.webContents.isDestroyed() ? orcaView.webContents : undefined;
}
