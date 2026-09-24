/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IKinguHostService } from '../../../../platform/kinguHost/common/kinguHostService.js';
import { IKinguAdvertisedUrlService, KinguAdvertisedUrlService } from './kinguAdvertisedUrlService.js';
import { isLocalhostEquivalent } from '../common/kinguAdvertisedUrls.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';

/*
 * The services and commands behind the Agents Window's footer.
 *
 * The footer itself is the ADE's now, drawn by
 * `electron-browser/kinguOrcaFooter.contribution.ts` from the ADE's own engine;
 * what stays here is what that footer, the Usage page and the command palette
 * still call.
 */

// Eager, unlike the rest: it has to be listening to the terminals before a dev
// server prints its address, and a server prints it once. Created lazily when
// the ports entry first asked, it would have missed every announcement made
// before that — which is all of them.
registerSingleton(IKinguAdvertisedUrlService, KinguAdvertisedUrlService, InstantiationType.Eager);

export const KINGU_REFRESH_QUOTAS_COMMAND_ID = 'kingu.status.refreshQuotas';
export const KINGU_OPEN_PORT_COMMAND_ID = 'kingu.status.openPort';

/**
 * Reads every provider again now.
 *
 * The gauges refresh on their own slow schedule, which is right for a number
 * that moves over hours — but a person who has just finished a long run wants
 * to see the cost of it without waiting, so clicking a gauge asks again.
 */
class RefreshKinguQuotasAction extends Action2 {

	constructor() {
		super({
			id: KINGU_REFRESH_QUOTAS_COMMAND_ID,
			title: localize2('kingu.status.refreshQuotas', "Kingu: Refresh Agent Quotas"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IKinguHostService).refresh();
	}
}

registerAction2(RefreshKinguQuotasAction);

/**
 * Opens one of the ports this app is serving.
 *
 * The number in the strip is where a person notices their dev server came up;
 * this is the step they take next, and without it they would read the number
 * and then type it into a browser themselves.
 */
class OpenKinguPortAction extends Action2 {

	constructor() {
		super({
			id: KINGU_OPEN_PORT_COMMAND_ID,
			title: localize2('kingu.status.openPort', "Kingu: Open a Listening Port"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// Taken before the first await: the accessor is only valid synchronously.
		const hostService = accessor.get(IKinguHostService);
		const quickInputService = accessor.get(IQuickInputService);
		const openerService = accessor.get(IOpenerService);
		const advertisedUrls = accessor.get(IKinguAdvertisedUrlService);

		const ports = await hostService.readListeningPorts();
		if (ports.length === 0) {
			return;
		}
		const picked = await quickInputService.pick(
			ports.map(port => {
				const advertised = advertisedUrls.get(port.port);
				return {
					label: String(port.port),
					description: port.process,
					// Shown so the choice is made on the address that will open, not on
					// a number and a hope. A port with no announcement shows none.
					detail: advertised?.url,
					port,
					advertised,
				};
			}),
			{ title: localize('kingu.status.openPort.title', "Open a listening port"), placeHolder: localize('kingu.status.openPort.placeholder', "Ports this app's processes are serving"), matchOnDetail: true });
		if (picked) {
			// The address the server announced, when it announced one: it knows its
			// own scheme, hostname and path, and none of those can be read off the
			// socket. Failing that, loopback — a server on `0.0.0.0` is reached from
			// this machine at localhost, and this machine is the one doing the asking.
			const fallback = `http://localhost:${picked.port.port}`;
			const candidate = picked.advertised?.url ?? fallback;
			// Checked again here even though nothing that is not this machine is
			// recorded. This is the line that actually navigates, and it is one
			// refactor away from being handed a URL that came from terminal output
			// without passing that filter; the check is cheap and the failure is a
			// person being sent to somebody else's site by a control labelled
			// "open this port".
			const url = URI.parse(candidate);
			const safe = (url.scheme === 'http' || url.scheme === 'https') && isLocalhostEquivalent(url.authority.replace(/^.*@/, '').replace(/:\d+$/, ''));
			await openerService.open(URI.parse(safe ? candidate : fallback), { openExternal: true });
		}
	}
}

registerAction2(OpenKinguPortAction);
