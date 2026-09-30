/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isKinguRecipeFileName, parseKinguRecipe } from '../../common/kinguRecipes.js';

suite('kinguRecipes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const manual = { interval: 'manual', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 };

	test('knows a recipe by its file name', () => {
		assert.deepStrictEqual(['review.yaml', 'Review.YML', 'shared.json', 'weekly.automation.md', 'notes.txt'].map(isKinguRecipeFileName), [true, true, true, false, false]);
	});

	test('reads a YAML recipe, filling its parameters', () => {
		const recipe = parseKinguRecipe([
			'version: 1.0.0',
			'title: Code review',
			'description: Review the changes on a branch',
			'instructions: |',
			'  You review code carefully.',
			'  Focus on {{ focus }}.',
			'prompt: Review the branch {{ branch }}.',
			'parameters:',
			'  - key: focus',
			'    input_type: string',
			'    requirement: optional',
			'    default: security',
			'  - key: branch',
			'    input_type: string',
			'    requirement: required',
			'    description: The branch to review',
		].join('\n'));
		assert.deepStrictEqual(recipe, {
			name: 'Code review',
			description: 'Review the changes on a branch',
			prompt: 'You review code carefully.\nFocus on security.\n\nReview the branch <branch>.\n\nParameters to fill in:\n- <branch>: The branch to review',
			schedule: manual,
		});
	});

	test('reads a JSON recipe shared from goose', () => {
		assert.deepStrictEqual(parseKinguRecipe(JSON.stringify({ recipe: { title: 'Standup', description: 'Daily notes', prompt: 'Summarize yesterday.' } })), {
			name: 'Standup',
			description: 'Daily notes',
			prompt: 'Summarize yesterday.',
			schedule: manual,
		});
	});

	test('refuses a file that is not a recipe', () => {
		assert.throws(() => parseKinguRecipe('services:\n  web:\n    image: nginx'), /invalidField: title/);
		assert.throws(() => parseKinguRecipe('title: Empty\ndescription: nothing to do'), /missingPrompt/);
	});
});
