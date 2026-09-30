/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { parse, YamlMapNode, YamlNode, YamlParseError } from '../../../../base/common/yaml.js';
import { AutomationBlueprintParseError } from '../../chat/common/automations/automationBlueprint.js';
import { IAutomationSchedule } from '../../chat/common/automations/automation.js';

/** The file types a goose recipe comes in; `.automation.md` stays the Automations' own. */
export const KINGU_RECIPE_FILE_EXTENSIONS = ['yaml', 'yml', 'json'];

/** Whether a file, by its name, is a goose recipe Automations can import. */
export function isKinguRecipeFileName(name: string): boolean {
	const lower = name.toLowerCase();
	return KINGU_RECIPE_FILE_EXTENSIONS.some(extension => lower.endsWith(`.${extension}`));
}

/** A goose recipe as an Automation to create: the dialog fills in the rest. */
export interface IKinguRecipe {
	readonly name: string;
	readonly description?: string;
	readonly prompt: string;
	readonly schedule: IAutomationSchedule;
}

interface IRecipeParameter {
	readonly key: string;
	readonly description?: string;
	readonly defaultValue?: string;
}

const MANUAL: IAutomationSchedule = { interval: 'manual', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 };

/**
 * Reads a goose recipe (https://block.github.io/goose/docs/guides/recipes/),
 * YAML or JSON, as an Automation: its `title` names it, its `instructions`
 * and `prompt` become the Automation's prompt, and each `{{ parameter }}` is
 * filled with the parameter's default, else left as `<parameter>` for the
 * user to fill in the dialog. A recipe has no schedule of its own (goose keeps
 * schedules apart), so it comes in to run by hand until the user picks one.
 *
 * Throws {@link AutomationBlueprintParseError}, so the import reports it as
 * it reports a bad blueprint.
 */
export function parseKinguRecipe(content: string): IKinguRecipe {
	const recipe = readRecipe(content);
	const title = recipe.title?.trim();
	if (!title) {
		throw new AutomationBlueprintParseError('invalidField', 'title');
	}
	const parameters = recipe.parameters ?? [];
	const fill = (text: string) => text.replace(/\{\{\s*(?<key>[\w.-]+)\s*\}\}/g, (match, _key: string, _offset: number, _all: string, groups: { key: string }) => {
		const parameter = parameters.find(candidate => candidate.key === groups.key);
		if (!parameter) {
			return match;
		}
		return parameter.defaultValue ?? `<${parameter.key}>`;
	});
	const parts = [recipe.instructions, recipe.prompt].map(part => part?.trim()).filter((part): part is string => !!part).map(fill);
	if (!parts.length) {
		throw new AutomationBlueprintParseError('missingPrompt');
	}
	const unfilled = parameters.filter(parameter => parameter.defaultValue === undefined);
	if (unfilled.length) {
		parts.push(['Parameters to fill in:', ...unfilled.map(parameter => `- <${parameter.key}>${parameter.description ? `: ${parameter.description}` : ''}`)].join('\n'));
	}
	const description = recipe.description?.trim();
	return {
		name: title,
		...(description ? { description } : {}),
		prompt: parts.join('\n\n'),
		schedule: MANUAL,
	};
}

interface IRawRecipe {
	readonly title?: string;
	readonly description?: string;
	readonly instructions?: string;
	readonly prompt?: string;
	readonly parameters?: readonly IRecipeParameter[];
}

function readRecipe(content: string): IRawRecipe {
	const trimmed = content.trim();
	if (trimmed.startsWith('{')) {
		let json: unknown;
		try {
			json = JSON.parse(trimmed);
		} catch {
			throw new AutomationBlueprintParseError('invalidFrontmatter');
		}
		// A recipe shared from goose may come wrapped as `{ "recipe": { … } }`.
		const value = isObject(json) && isObject(json.recipe) ? json.recipe : json;
		if (!isObject(value)) {
			throw new AutomationBlueprintParseError('invalidFrontmatter');
		}
		return {
			title: stringOf(value.title),
			description: stringOf(value.description),
			instructions: stringOf(value.instructions),
			prompt: stringOf(value.prompt),
			parameters: Array.isArray(value.parameters) ? value.parameters.filter(isObject).map(parameter => ({
				key: stringOf(parameter.key) ?? '',
				description: stringOf(parameter.description),
				defaultValue: scalarOf(parameter.default),
			})).filter(parameter => parameter.key) : undefined,
		};
	}
	const errors: YamlParseError[] = [];
	const root = parse(content, errors);
	if (!root || root.type !== 'map' || errors.length) {
		throw new AutomationBlueprintParseError('invalidFrontmatter');
	}
	const map = mapValue(root, 'recipe') ?? root;
	const parameters = map.properties.find(property => property.key.value === 'parameters')?.value;
	return {
		title: scalarValue(map, 'title'),
		description: scalarValue(map, 'description'),
		instructions: scalarValue(map, 'instructions'),
		prompt: scalarValue(map, 'prompt'),
		parameters: parameters?.type === 'sequence' ? parameters.items.filter((item): item is YamlMapNode => item.type === 'map').map(item => ({
			key: scalarValue(item, 'key') ?? '',
			description: scalarValue(item, 'description'),
			defaultValue: scalarValue(item, 'default'),
		})).filter(parameter => parameter.key) : undefined,
	};
}

function scalarValue(map: YamlMapNode, key: string): string | undefined {
	const node: YamlNode | undefined = map.properties.find(property => property.key.value === key)?.value;
	return node?.type === 'scalar' ? node.value : undefined;
}

function mapValue(map: YamlMapNode, key: string): YamlMapNode | undefined {
	const node = map.properties.find(property => property.key.value === key)?.value;
	return node?.type === 'map' ? node : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function scalarOf(value: unknown): string | undefined {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}
