import { stripCredentialsFromMessage } from './git-remote-error'
import type { KinguVmRecipe } from './kingu-yaml-hook-types'

export function getProvisionedRootRecipeRepoUrl(
  checkoutMode: KinguVmRecipe['checkoutMode'],
  remoteUrl: string | undefined
): string | undefined {
  if (checkoutMode !== 'provisioned-root' || !remoteUrl) {
    return undefined
  }
  return stripCredentialsFromMessage(remoteUrl)
}
