// Why per platform: macOS and Windows desktops do have an OS keychain; kingud just does not use
// it, so "this host has no keyring" sent users looking for one they already had.
export function describeKingudSecretProtectionGap(platform: NodeJS.Platform): string {
  const keychain =
    platform === 'darwin'
      ? 'the macOS Keychain'
      : platform === 'win32'
        ? 'Windows credential protection'
        : 'the OS keyring'
  return `Kingu's headless server does not use ${keychain}, so credentials are stored unencrypted on this host. Pair from a desktop to manage secrets.`
}
