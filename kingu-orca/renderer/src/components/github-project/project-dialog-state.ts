type RepoBackedProjectDialogState = {
  repoId: string
}

type SlugProjectDialogState = {
  origin: {
    owner: string
    repo: string
    host?: string
  }
}

type RepoNotInKinguDialogState = {
  owner: string
  repo: string
  host?: string
}

type RepoMatch = {
  id: string
}

type LookupSlug = (slug: string, host?: string) => readonly RepoMatch[]

function shouldCloseFallbackDialog(args: {
  lookupSlug: LookupSlug
  selectedRepoIds: ReadonlySet<string>
  owner: string
  repo: string
  host?: string
}): boolean {
  const matches = args.lookupSlug(`${args.owner}/${args.repo}`, args.host)
  const selectedMatchCount = matches.filter((match) => args.selectedRepoIds.has(match.id)).length
  const unselectedMatchCount = matches.length - selectedMatchCount
  return selectedMatchCount > 0 || unselectedMatchCount > 0
}

export function resolveRepoBackedProjectDialogState<T extends RepoBackedProjectDialogState>(
  dialog: T | null,
  liveRepoIds: ReadonlySet<string>,
  selectedRepoIds: ReadonlySet<string>
): T | null {
  if (dialog && (!liveRepoIds.has(dialog.repoId) || !selectedRepoIds.has(dialog.repoId))) {
    return null
  }
  return dialog
}

export function resolveMissingRepoProjectDialogState<
  TSlugDialog extends SlugProjectDialogState,
  TRepoNotInKingu extends RepoNotInKinguDialogState
>(args: {
  slugIndexReady: boolean
  slugDialog: TSlugDialog | null
  repoNotInKingu: TRepoNotInKingu | null
  lookupSlug: LookupSlug
  selectedRepoIds: ReadonlySet<string>
}): {
  slugDialog: TSlugDialog | null
  repoNotInKingu: TRepoNotInKingu | null
} {
  const { lookupSlug, repoNotInKingu, selectedRepoIds, slugDialog, slugIndexReady } = args
  if (!slugIndexReady) {
    return { slugDialog: null, repoNotInKingu: null }
  }
  return {
    slugDialog:
      slugDialog &&
      shouldCloseFallbackDialog({
        lookupSlug,
        selectedRepoIds,
        owner: slugDialog.origin.owner,
        repo: slugDialog.origin.repo,
        host: slugDialog.origin.host
      })
        ? null
        : slugDialog,
    repoNotInKingu:
      repoNotInKingu &&
      shouldCloseFallbackDialog({
        lookupSlug,
        selectedRepoIds,
        owner: repoNotInKingu.owner,
        repo: repoNotInKingu.repo,
        host: repoNotInKingu.host
      })
        ? null
        : repoNotInKingu
  }
}
