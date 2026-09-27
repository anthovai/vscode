import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_RIPGREP_PLATFORMS, bundledRipgrepBinaryName } from './bundled-ripgrep'
import {
  KINGUD_RIPGREP_ARTIFACTS,
  KINGUD_RIPGREP_LICENSE_ARTIFACTS,
  kingudArtifactFilenames
} from './kingud-artifacts'

describe('standalone runtime artifacts', () => {
  it('ships search binaries for every SSH host and includes them in the install identity', () => {
    const expected = BUNDLED_RIPGREP_PLATFORMS.map(
      (platform) => `ripgrep/${platform}/${bundledRipgrepBinaryName(platform)}`
    )
    expect(KINGUD_RIPGREP_ARTIFACTS).toEqual(expected)
    expect(kingudArtifactFilenames()).toEqual(expect.arrayContaining(expected))
  })

  it('ships the binary redistribution notices with every install', () => {
    const sourceDir = join(__dirname, '../../resources/licenses/ripgrep')
    expect(KINGUD_RIPGREP_LICENSE_ARTIFACTS.map((path) => path.split('/').at(-1)).sort()).toEqual(
      readdirSync(sourceDir).sort()
    )
    expect(kingudArtifactFilenames()).toEqual(
      expect.arrayContaining([...KINGUD_RIPGREP_LICENSE_ARTIFACTS])
    )
  })
})
