export function getKinguCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'kingu-ide'
  }
  if (platform === 'win32') {
    return 'kingu.cmd'
  }
  return 'kingu'
}
