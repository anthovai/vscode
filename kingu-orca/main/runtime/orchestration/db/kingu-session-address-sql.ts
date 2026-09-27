import { KINGU_SESSION_ADDRESS_PREFIX } from '../../../../shared/kingu-session-address'

/**
 * The `session:<id>` address of a bare Kingu session id column or expression, NULL when it is NULL.
 * The only way SQL compares a stored id with a mail address: the id side is formatted, never the
 * address side stripped, so a handle or `run:` address can never equal a bare id.
 */
export function kinguSessionAddressSql(kinguSessionIdSql: string): string {
  return `('${KINGU_SESSION_ADDRESS_PREFIX}' || ${kinguSessionIdSql})`
}
