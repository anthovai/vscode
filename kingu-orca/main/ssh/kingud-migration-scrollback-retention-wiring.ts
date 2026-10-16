import type { Store } from '../persistence'
import {
  listKingudMigrationSourceCutovers,
  setKingudMigrationJournalChangeListener
} from './kingud-migration-cutover-journal'

/** Keeps the store's scrollback retention in step with the journal, from startup on. */
export function installKingudMigrationScrollbackRetention(
  userDataPath: string,
  store: Pick<Store, 'syncKingudMigrationScrollbackRetention'>
): void {
  const sync = (path: string): void => {
    try {
      // Held until the destination has the bytes; committed or abandoned migrations release them.
      const pending = listKingudMigrationSourceCutovers(path).filter(
        (cutover) => cutover.phase === 'source-fenced' || cutover.phase === 'destination-staged'
      )
      store.syncKingudMigrationScrollbackRetention(pending.map((cutover) => cutover.manifest))
    } catch (error) {
      // An unreadable journal keeps whatever is held; releasing on a guess could lose bytes.
      console.warn('[kingud-migration] Could not sync scrollback retention:', error)
    }
  }
  setKingudMigrationJournalChangeListener(sync)
  sync(userDataPath)
}
