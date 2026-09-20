/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { KINGU_QUOTA_PROVIDERS, KinguQuotaProvider } from '../../../../platform/kinguHost/common/kinguQuotaProviders.js';
import { KinguQuotaResult } from '../../../../platform/kinguHost/common/kinguRateLimits.js';
import { IKinguHostService, IKinguMemoryReading } from '../../../../platform/kinguHost/common/kinguHostService.js';
import { IKinguListeningPort } from '../../../../platform/kinguHost/common/kinguHostPorts.js';
import { KINGU_HOST_CHANNEL_NAME } from '../../../../platform/kinguHost/common/kinguHostTypes.js';

/**
 * The window's view of what only the machine's own process can see.
 *
 * A thin client on purpose. Reading each provider's credential and calling it
 * both happen in the main process — a renderer's `vscode-file://` origin cannot
 * reach these endpoints, and keeping it there means no token crosses into a
 * window. What comes back is percentages and reset times, a byte count, and a
 * list of ports.
 */
export class KinguHostService extends Disposable implements IKinguHostService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _channel: IChannel;
	private readonly _quotas = new Map<KinguQuotaProvider, KinguQuotaResult>();
	private _inFlight: Promise<void> | undefined;

	get quotas(): ReadonlyMap<KinguQuotaProvider, KinguQuotaResult> {
		return this._quotas;
	}

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._channel = mainProcessService.getChannel(KINGU_HOST_CHANNEL_NAME);
	}

	refresh(): Promise<void> {
		// Shared rather than queued: two callers wanting the current numbers want
		// the same round of requests, not two of them against each provider.
		this._inFlight ??= this._refresh().finally(() => { this._inFlight = undefined; });
		return this._inFlight;
	}

	async readMemory(): Promise<IKinguMemoryReading | undefined> {
		try {
			return await this._channel.call<IKinguMemoryReading | undefined>('getMemoryBytes');
		} catch {
			return undefined;
		}
	}

	async readListeningPorts(): Promise<readonly IKinguListeningPort[]> {
		try {
			return await this._channel.call<readonly IKinguListeningPort[]>('getListeningPorts');
		} catch {
			return [];
		}
	}

	async findExecutables(commands: readonly string[]): Promise<Readonly<Record<string, string>>> {
		try {
			return await this._channel.call<Record<string, string>>('findExecutables', commands);
		} catch {
			return {};
		}
	}

	private async _refresh(): Promise<void> {
		// In parallel because they are separate providers: one being slow or down
		// must not delay the others' gauges.
		const readings = await Promise.all(KINGU_QUOTA_PROVIDERS.map(async provider => {
			try {
				return [provider, await this._channel.call<KinguQuotaResult>('getQuota', provider)] as const;
			} catch {
				this._logService.warn(`[Kingu] the quota channel did not answer for ${provider}`);
				const unavailable: KinguQuotaResult = { ok: false, problem: 'unavailable' };
				return [provider, unavailable] as const;
			}
		}));

		let changed = false;
		for (const [provider, result] of readings) {
			if (JSON.stringify(this._quotas.get(provider)) !== JSON.stringify(result)) {
				changed = true;
			}
			this._quotas.set(provider, result);
		}
		if (changed) {
			this._onDidChange.fire();
		}
	}
}
