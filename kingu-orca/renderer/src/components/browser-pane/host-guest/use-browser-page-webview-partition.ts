import { useAppStore } from '@/store'
import { KINGU_BROWSER_PARTITION } from '../../../../../shared/constants'
import { getKinguProfileBrowserDefaultPartition } from '../../../../../shared/kingu-profiles'

export function useBrowserPageWebviewPartition({
  sessionProfileId,
  sessionPartition
}: {
  sessionProfileId: string | null
  sessionPartition: string | null
}): string {
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const activeKinguProfileId = useAppStore((s) => s.activeKinguProfileId)
  const fallbackBrowserPartition = activeKinguProfileId
    ? getKinguProfileBrowserDefaultPartition(activeKinguProfileId)
    : null
  const defaultSessionProfile = browserSessionProfiles.find((p) => p.id === 'default') ?? null
  const sessionProfile = sessionProfileId
    ? (browserSessionProfiles.find((p) => p.id === sessionProfileId) ?? null)
    : defaultSessionProfile
  return (
    sessionPartition ??
    sessionProfile?.partition ??
    defaultSessionProfile?.partition ??
    fallbackBrowserPartition ??
    KINGU_BROWSER_PARTITION
  )
}
