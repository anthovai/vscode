/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IKinguHostService } from '../../../../platform/kinguHost/common/kinguHostService.js';
import { describeComputerAction, KINGU_ALLOW_INPUT_SETTING, KinguComputerResult } from '../../../../platform/kinguComputer/common/kinguComputerProtocol.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

/**
 * What an application's window list looks like once the runtime has answered.
 *
 * Read defensively: this crosses a process boundary from a PowerShell script,
 * so every field is checked rather than asserted. A shape that is not what was
 * expected is reported as an empty list, not as a crash halfway through drawing
 * a picker.
 */
function readWindows(result: KinguComputerResult): { title: string; id?: string }[] {
	if (!result.ok) {
		return [];
	}
	const windows = (result.value as { windows?: unknown })?.windows;
	if (!Array.isArray(windows)) {
		return [];
	}
	return windows.flatMap(entry => {
		const window = entry as { title?: unknown; windowId?: unknown };
		const title = typeof window.title === 'string' && window.title.trim() ? window.title : undefined;
		return title ? [{ title, id: typeof window.windowId === 'string' ? window.windowId : undefined }] : [];
	});
}

function readApps(result: KinguComputerResult): string[] {
	if (!result.ok) {
		return [];
	}
	const apps = (result.value as { apps?: unknown })?.apps;
	if (!Array.isArray(apps)) {
		return [];
	}
	return apps.flatMap(entry => {
		if (typeof entry === 'string') {
			return entry.trim() ? [entry] : [];
		}
		const name = (entry as { name?: unknown })?.name;
		return typeof name === 'string' && name.trim() ? [name] : [];
	});
}

/**
 * Shows what is on the desktop.
 *
 * The visible half of a capability whose point is that an agent can see what a
 * person sees. It exists as a command first so the bridge can be exercised by
 * the person who owns the desktop, before anything automated reads it — a
 * feature that reads every window on the machine should be something the user
 * has run themselves once.
 *
 * Reading only. There is no path from here to clicking or typing.
 */
class KinguReadDesktopAction extends Action2 {

	static readonly ID = 'kingu.computer.read';

	constructor() {
		super({
			id: KinguReadDesktopAction.ID,
			title: localize2('kingu.computer.read', "Kingu: Read the Desktop"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const hostService = accessor.get(IKinguHostService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const apps = await hostService.readDesktop({ tool: 'list_apps' });
		if (!apps.ok) {
			notificationService.notify({ severity: Severity.Error, message: localize('kingu.computer.failed', "Could not read the desktop: {0}", apps.error) });
			return;
		}
		const names = readApps(apps);
		if (names.length === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('kingu.computer.none', "The desktop runtime reported no applications with windows.") });
			return;
		}

		const picked = await quickInputService.pick(names.map((name): IQuickPickItem => ({ label: name })), {
			title: localize('kingu.computer.appsTitle', "Applications on this desktop"),
			placeHolder: localize('kingu.computer.appsPlaceholder', "{0} with a window. Pick one to list its windows.", names.length),
		});
		if (!picked) {
			return;
		}

		const windows = await hostService.readDesktop({ tool: 'list_windows', app: picked.label });
		if (!windows.ok) {
			notificationService.notify({ severity: Severity.Error, message: localize('kingu.computer.failed', "Could not read the desktop: {0}", windows.error) });
			return;
		}
		const titles = readWindows(windows);
		await quickInputService.pick(titles.map((window): IQuickPickItem => ({ label: window.title, description: window.id })), {
			title: localize('kingu.computer.windowsTitle', "Windows of {0}", picked.label),
			placeHolder: titles.length > 0
				? localize('kingu.computer.windowsPlaceholder', "Read from the accessibility tree, not from pixels.")
				: localize('kingu.computer.noWindows', "No windows were reported."),
		});
	}
}

registerAction2(KinguReadDesktopAction);

/**
 * The permission to act, as a setting the user owns.
 *
 * Off by default, and described in the terms that matter rather than in the
 * feature's own vocabulary: the question a person is answering is not "enable
 * computer use" but "may this type into my other applications".
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu',
	order: 100,
	title: localize('kingu.configuration.title', "Kingu"),
	type: 'object',
	properties: {
		[KINGU_ALLOW_INPUT_SETTING]: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('kingu.computerUse.allowInput.description', "Allow Kingu to click, type and paste into other applications on this computer. Reading which windows are open does not need this. Off by default: anything that can use your keyboard can accept a dialog or send a message, and every action still asks first."),
			tags: ['usesOnlineServices'],
		},
	},
});

/**
 * Does one thing to the desktop, after asking.
 *
 * The confirmation is not ceremony. It names the application and quotes the
 * text in full, because the moment worth interrupting is precisely the one
 * where something is about to be typed somewhere the user was not looking.
 *
 * The permission is checked in the main process too, and this dialog cannot
 * substitute for it: a window is what an agent can reach, and a gate a window
 * owns is a gate that can be asked to open itself.
 */
class KinguActOnDesktopAction extends Action2 {

	static readonly ID = 'kingu.computer.act';

	constructor() {
		super({
			id: KinguActOnDesktopAction.ID,
			title: localize2('kingu.computer.act', "Kingu: Type Into Another Application"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const hostService = accessor.get(IKinguHostService);
		const quickInputService = accessor.get(IQuickInputService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);

		const apps = await hostService.readDesktop({ tool: 'list_apps' });
		if (!apps.ok) {
			notificationService.notify({ severity: Severity.Error, message: localize('kingu.computer.failed', "Could not read the desktop: {0}", apps.error) });
			return;
		}
		const names = readApps(apps);
		const app = await quickInputService.pick(names.map((name): IQuickPickItem => ({ label: name })), {
			title: localize('kingu.computer.actTarget', "Type into which application?"),
			placeHolder: localize('kingu.computer.actTargetPlaceholder', "The text goes to whatever holds focus in it."),
		});
		if (!app) {
			return;
		}
		const text = await quickInputService.input({
			title: localize('kingu.computer.actText', "Type into {0}", app.label),
			prompt: localize('kingu.computer.actTextPrompt', "Sent as keystrokes, exactly as written."),
		});
		if (!text) {
			return;
		}

		// Focus is taken deliberately. The runtime refuses keyboard input to an
		// unfocused window, because keystrokes go wherever focus is — so an action
		// that did not do this would type into whatever the user was using instead.
		const request = { tool: 'type_text', app: app.label, text, restoreWindow: true } as const;
		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: localize('kingu.computer.confirm', "Let Kingu use your keyboard?"),
			detail: localize('kingu.computer.confirmDetail', "{0}\n\n{1} is brought to the front first, and the keystrokes go to it rather than to Kingu.", describeComputerAction(request), app.label),
			primaryButton: localize('kingu.computer.confirmButton', "Type it"),
		});
		if (!confirmed) {
			return;
		}

		const result = await hostService.readDesktop(request);
		if (!result.ok) {
			notificationService.notify({ severity: Severity.Error, message: localize('kingu.computer.actFailed', "Could not type into {0}: {1}", app.label, result.error) });
		}
	}
}

registerAction2(KinguActOnDesktopAction);
