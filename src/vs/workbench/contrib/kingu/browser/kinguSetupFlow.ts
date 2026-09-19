/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { KINGU_DEFAULT_ANTHROPIC_BASE_URL, KINGU_VENDOR_ID, KinguApiFormat } from '../common/kinguLanguageModels.js';

/** Where an OpenAI-dialect endpoint most often lives, offered as the prefilled value. */
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

interface IFormatPick extends IQuickPickItem {
	readonly format: KinguApiFormat;
}

/**
 * Walks the user through adding one Kingu endpoint.
 *
 * This exists so a signed-out install has a route to a model that is Kingu's own:
 * the workbench's model management UI belongs to the Copilot extension, and on a
 * fresh profile there is no extension, no account and no marketplace yet.
 *
 * The API key is typed into a masked quick input and handed straight to
 * {@link ILanguageModelsService.addLanguageModelsProviderGroup}, which routes it
 * into secret storage because the vendor's schema marks it `secret`. It is never
 * written to settings and never returned from here.
 *
 * Returns whether an endpoint was added; cancelling at any step adds nothing.
 */
export async function runKinguSetupFlow(
	quickInputService: IQuickInputService,
	languageModelsService: ILanguageModelsService,
	notificationService: INotificationService,
	logService: ILogService,
): Promise<boolean> {
	const formatPicks: IFormatPick[] = [
		{
			format: 'anthropic',
			label: localize('kingu.setup.format.anthropic', "Anthropic"),
			detail: localize('kingu.setup.format.anthropic.detail', "Anthropic's Messages API, and the gateways that re-implement it."),
		},
		{
			format: 'openai',
			label: localize('kingu.setup.format.openai', "OpenAI"),
			detail: localize('kingu.setup.format.openai.detail', "The OpenAI chat completions API, spoken by most gateways and local model servers."),
		},
	];
	const formatPick = await quickInputService.pick(formatPicks, {
		title: localize('kingu.setup.title', "Add a Kingu Endpoint"),
		placeHolder: localize('kingu.setup.format.placeholder', "Which API does this endpoint speak?"),
	});
	if (!formatPick) {
		return false;
	}
	const format = formatPick.format;

	const baseUrl = await quickInputService.input({
		title: localize('kingu.setup.title', "Add a Kingu Endpoint"),
		prompt: localize('kingu.setup.baseUrl.prompt', "Base URL of the endpoint, without a trailing path."),
		value: format === 'anthropic' ? KINGU_DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL,
		// A wrong URL is the commonest way this flow fails, and it is invisible once
		// the quick input closes, so it is rejected here rather than at request time.
		validateInput: async value => isPlausibleBaseUrl(value)
			? undefined
			: localize('kingu.setup.baseUrl.invalid', "Enter an http or https URL, for example https://api.anthropic.com"),
	});
	if (baseUrl === undefined) {
		return false;
	}

	const models = await quickInputService.input({
		title: localize('kingu.setup.title', "Add a Kingu Endpoint"),
		prompt: localize('kingu.setup.models.prompt', "Model ids to offer, comma-separated. Leave empty to list whatever the endpoint reports."),
		placeHolder: localize('kingu.setup.models.placeholder', "claude-opus-5, claude-sonnet-5"),
	});
	if (models === undefined) {
		return false;
	}

	const apiKey = await quickInputService.input({
		title: localize('kingu.setup.title', "Add a Kingu Endpoint"),
		prompt: localize('kingu.setup.apiKey.prompt', "API key for this endpoint. It is stored in the OS keychain, never in your settings."),
		password: true,
		// The key is pasted from elsewhere, and losing it to a stray focus change
		// means starting the whole flow over.
		ignoreFocusLost: true,
		validateInput: async value => value.trim()
			? undefined
			: localize('kingu.setup.apiKey.required', "An API key is required."),
	});
	if (apiKey === undefined || !apiKey.trim()) {
		return false;
	}

	// The group name is what the model picker shows above this endpoint's models,
	// so it names the endpoint rather than the vendor.
	const name = hostnameOf(baseUrl) ?? 'Kingu';
	try {
		await languageModelsService.addLanguageModelsProviderGroup(name, KINGU_VENDOR_ID, {
			apiKey: apiKey.trim(),
			baseUrl: baseUrl.trim(),
			format,
			models: models.trim(),
		});
	} catch (error) {
		logService.error('[Kingu] could not add endpoint', error);
		notificationService.notify({
			severity: Severity.Error,
			message: localize('kingu.setup.failed', "Could not add the Kingu endpoint: {0}", error instanceof Error ? error.message : String(error)),
		});
		return false;
	}

	notificationService.notify({
		severity: Severity.Info,
		message: localize('kingu.setup.added', "Added the Kingu endpoint {0}. Its models are now in the model picker.", name),
	});
	return true;
}

function isPlausibleBaseUrl(value: string): boolean {
	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

function hostnameOf(value: string): string | undefined {
	try {
		return new URL(value.trim()).hostname || undefined;
	} catch {
		return undefined;
	}
}
