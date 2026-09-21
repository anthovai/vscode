import { ipcMain } from 'electron'
import { appStarSourceSchema } from '../../shared/gh-star-source'
import { diagnoseGhAuth } from '../github/auth-diagnose'
import { checkKinguStarred, getAuthenticatedViewer, starKingu } from '../github/client'
import { getRateLimit } from '../github/rate-limit'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { track } from '../telemetry/client'

export function registerGitHubAccountHandlers(): void {
  ipcMain.handle('gh:viewer', () => getAuthenticatedViewer())
  ipcMain.handle('gh:checkKinguStarred', () => checkKinguStarred())
  ipcMain.handle('gh:starKingu', async (_event, source: unknown) => {
    const sourceParse = appStarSourceSchema.safeParse(source)
    const starred = await starKingu()
    if (starred && sourceParse.success) {
      track('app_starred_kingu', {
        source: sourceParse.data,
        ...getCohortAtEmit()
      })
    }
    return starred
  })

  ipcMain.handle('gh:rateLimit', (_event, args?: { force?: boolean }) =>
    getRateLimit(args?.force ? { force: true } : undefined)
  )

  ipcMain.handle('gh:diagnoseAuth', (_event, args?: { host?: string }) =>
    diagnoseGhAuth(args?.host)
  )
}
