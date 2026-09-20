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
import { KinguComputerResult } from '../../../../platform/kinguComputer/common/kinguComputerProtocol.js';

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
