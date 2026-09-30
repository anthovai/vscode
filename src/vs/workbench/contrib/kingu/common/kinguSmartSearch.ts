/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Setting: the Search view widens a plain query (`kinguSmartSearchPattern`). */
export const KINGU_SMART_SEARCH_SETTING = 'kingu.search.smart';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu.search',
	title: localize('kingu.search.configuration', "Kingu Search"),
	type: 'object',
	properties: {
		[KINGU_SMART_SEARCH_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('kingu.search.smart', "Find what a plain search means, not only what it spells: any letter case, the words in any order, and a name however it is written (`stock ledger` finds `stockLedger`, `stock_ledger`, `StockLedger` and `ledger of stock`). Turn on Use Regular Expression, Match Case or Match Whole Word to search exactly."),
		},
	},
});

/** What may join the words of a name: nothing, `_`, `-`, `.` or a space. */
const NAME_SEPARATOR = '[\\s_\\-.]*';

/** More words than this are kept in the order typed; every order of five would be 120 alternatives. */
const MAX_REORDERED_WORDS = 3;

/** The words of a query, with names split where they are joined: `stockLedger`, `stock_ledger` and `stock-ledger` are two words. */
export function smartSearchWords(query: string): string[] {
	return query
		.trim()
		.split(/\s+/)
		.flatMap(token => token
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
			.split(/[\s_\-.]+/))
		.filter(Boolean);
}

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) {
		return [items.slice()];
	}
	return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

/**
 * A plain query as the regular expression Kingu searches with, to be matched
 * without regard to case: the words joined as a name is (nothing, `_`, `-`,
 * `.` or a space between them) or farther apart on the same line, in any
 * order for up to three words. A single word is itself. `undefined` when the
 * query has nothing to widen.
 */
export function kinguSmartSearchPattern(query: string): string | undefined {
	const words = smartSearchWords(query);
	if (words.length === 0) {
		return undefined;
	}
	if (words.length === 1) {
		return words[0] === query.trim() ? undefined : escapeRegExpCharacters(words[0]);
	}
	const escaped = words.map(escapeRegExpCharacters);
	const orders = escaped.length <= MAX_REORDERED_WORDS ? permutations(escaped) : [escaped];
	const close = orders.map(order => order.join(NAME_SEPARATOR));
	const apart = orders.map(order => order.join('.*?'));
	return [...close, ...apart].join('|');
}

/**
 * The words a smart pattern was made from, for a search that wants the query
 * as typed rather than the pattern (search by meaning is handed the pattern,
 * as it is the query the Search view ran). Any other text comes back as is.
 */
export function kinguSmartSearchQueryText(pattern: string): string {
	const first = pattern.split('|')[0];
	if (!first.includes(NAME_SEPARATOR)) {
		return pattern;
	}
	return first.split(NAME_SEPARATOR).map(word => word.replace(/\\(.)/g, '$1')).join(' ');
}
