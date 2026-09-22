/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKinguRuntimeService, KINGU_RUNTIME_ENTRY_SETTING, KINGU_RUNTIME_WEB_ROOT_SETTING } from '../../../../platform/kinguRuntime/common/kinguRuntime.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { KinguRuntimeService } from './kinguRuntimeService.js';

export const KINGU_OPEN_WORKBENCH_COMMAND_ID = 'kingu.workbench.open';
export const KINGU_EXIT_WORKBENCH_COMMAND_ID = 'kingu.workbench.exit';

/**
 * The parts Kingu's own UI replaces.
 *
 * Kingu draws its own sidebar, its own panel and its own side panes, so leaving
 * the fork's in place would put two of each on screen. The title bar stays: it
 * is the window's chrome — navigation, the session title, the traffic lights —
 * and nothing in the page draws it.
 */
const COVERED_PARTS: readonly Parts[] = [
	Parts.SIDEBAR_PART,
	Parts.PANEL_PART,
	Parts.AUXILIARYBAR_PART,
	Parts.SESSIONS_PART,
];

// Delayed: starting the runtime is a child process and a web server, and nothing
// should pay for either until someone asks for the workbench.
registerSingleton(IKinguRuntimeService, KinguRuntimeService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu',
	title: localize('kingu.runtime.title', "Kingu Runtime"),
	properties: {
		[KINGU_RUNTIME_ENTRY_SETTING]: {
			type: 'string',
			default: '',
			description: localize('kingu.runtime.entry.description', "Path to the built Kingu runtime (`out/kingud/kingud.js`). Empty looks for a `kingu-intelligence` checkout beside this one."),
		},
		[KINGU_RUNTIME_WEB_ROOT_SETTING]: {
			type: 'string',
			default: '',
			description: localize('kingu.runtime.webRoot.description', "Path to the built Kingu web client (`out/web`). Empty looks for a `kingu-intelligence` checkout beside this one."),
		},
	},
});

/**
 * Replaces the Agents Window with Kingu's own UI.
 *
 * Not a tab beside the fork's surfaces — the window becomes Kingu. The fork's
 * sidebar, panel, side panel and sessions grid are hidden, and Kingu's client
 * fills what is left. It is not a port and not a copy: the same client the
 * desktop app ships, served from the build next door and paired to a runtime
 * this window started, which is why it can be the entire product rather than
 * the handful of surfaces a hand-port reaches.
 *
 * It is a browser view rather than an `<iframe>` because the workbench's CSP is
 * `frame-src 'self' vscode-webview:`, so a frame pointed at loopback is refused.
 * The browser view is an Electron `WebContentsView` over the window rather than
 * a frame inside the document, so it is not subject to that policy — and this
 * uses the fork's own browser, not a hole cut in its CSP.
 *
 * The seam is the runtime's pairing + RPC surface, not Electron IPC. The same
 * surface is what a future in-process backend would implement, and what the
 * SvelteKit client will talk to, so neither has to wait on this one.
 */
class OpenKinguWorkbenchAction extends Action2 {

	constructor() {
		super({
			id: KINGU_OPEN_WORKBENCH_COMMAND_ID,
			title: localize2('kingu.openWorkbench', "Kingu: Open Workbench"),
			category: Categories.View,
			icon: Codicon.window,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const runtimeService = accessor.get(IKinguRuntimeService);
		const browserViewService = accessor.get(IBrowserViewWorkbenchService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		// Before the first await: the accessor is only valid synchronously.
		const layoutService = accessor.get(IWorkbenchLayoutService);

		let endpoint;
		try {
			// Under progress because a cold start builds a terminal daemon and
			// self-tests it, which is seconds of nothing happening otherwise.
			endpoint = await progressService.withProgress(
				{ location: ProgressLocation.Window, title: localize('kingu.startingRuntime', "Starting the Kingu runtime…") },
				() => runtimeService.start());
		} catch (error) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('kingu.runtimeFailed', "Could not start the Kingu runtime: {0}", error instanceof Error ? error.message : String(error)),
			});
			return;
		}

		// A fresh id per invocation: the URL carries a one-time pairing offer, so
		// reusing a tab would reopen it with a code the client has already
		// consumed and stripped from its address bar.
		const input = browserViewService.getOrCreateLazy({
			id: generateUuid(),
			url: endpoint.webUrl,
			title: localize('kingu.workbenchTitle', "Kingu"),
		});
		await editorService.openEditor(input, { pinned: true });

		// Hidden only once the page is open, so a failure above leaves the window
		// as it was rather than emptied.
		for (const part of COVERED_PARTS) {
			layoutService.setPartHidden(true, part);
		}
	}
}

registerAction2(OpenKinguWorkbenchAction);

/**
 * Gives the Agents Window back.
 *
 * The counterpart to opening, and the reason opening is allowed to hide four
 * parts at once: a surface that takes over the window has to be leaveable, or
 * the only way out is a restart.
 */
class ExitKinguWorkbenchAction extends Action2 {

	constructor() {
		super({
			id: KINGU_EXIT_WORKBENCH_COMMAND_ID,
			title: localize2('kingu.exitWorkbench', "Kingu: Close Workbench and Show Sessions"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		for (const part of COVERED_PARTS) {
			layoutService.setPartHidden(false, part);
		}
	}
}

registerAction2(ExitKinguWorkbenchAction);
