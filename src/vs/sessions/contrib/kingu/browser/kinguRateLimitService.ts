/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IKinguRateLimitService, KinguQuotaResult } from '../../../../platform/kinguRateLimits/common/kinguRateLimits.js';
import { KINGU_RATE_LIMIT_CHANNEL_NAME } from '../../../../platform/kinguRateLimits/common/kinguRateLimitTypes.js';

/**
 * The window's view of the quota on accounts this machine is signed into.
 *
 * A thin client on purpose. The credential read and the call to the provider
 * both happen in the main process — a renderer's `vscode-file://` origin cannot
 * reach the provider, and keeping it there means the token never crosses into a
 * window. What comes back is percentages and reset times.
 */
export class KinguRateLimitService extends Disposable implements IKinguRateLimitService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _channel: IChannel;
	private _claude: KinguQuotaResult | undefined;
	private _inFlight: Promise<void> | undefined;

	get claude(): KinguQuotaResult | undefined {
		return this._claude;
	}

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._channel = mainProcessService.getChannel(KINGU_RATE_LIMIT_CHANNEL_NAME);
	}

	refresh(): Promise<void> {
		// Shared rather than queued: two callers wanting the current number want the
		// same request, not two of them against the provider.
		this._inFlight ??= this._refresh().finally(() => { this._inFlight = undefined; });
		return this._inFlight;
	}

	private async _refresh(): Promise<void> {
		let next: KinguQuotaResult;
		try {
			next = await this._channel.call<KinguQuotaResult>('getClaudeQuota');
		} catch (error) {
			this._logService.warn('[Kingu] the quota channel did not answer');
			next = { ok: false, problem: 'unavailable' };
		}
		const changed = JSON.stringify(next) !== JSON.stringify(this._claude);
		this._claude = next;
		if (changed) {
			this._onDidChange.fire();
		}
	}
}
