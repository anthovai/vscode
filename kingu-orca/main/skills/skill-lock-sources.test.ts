import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSkillLockSources } from './skill-lock-sources'

const temporaryDirectories: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kingu-skill-lock-sources-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('skills.sh lock sources', () => {
  it('reads each entry source regardless of how its hash was recorded', async () => {
    const homeDir = await temporaryRoot()
    await mkdir(join(homeDir, '.agents'), { recursive: true })
    await writeFile(
      join(homeDir, '.agents', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          orchestration: { skillFolderHash: 'a'.repeat(64), source: 'anthovai/kingu-intelligence' },
          'computer-use': { source: 'acme/agent-skills' },
          copied: {},
          emptySource: { source: '' },
          constructor: { source: 'anthovai/kingu-intelligence' }
        }
      })
    )

    await expect(readSkillLockSources({ homeDir, stateHome: null })).resolves.toEqual(
      new Map([
        ['orchestration', 'anthovai/kingu-intelligence'],
        ['computer-use', 'acme/agent-skills'],
        ['constructor', 'anthovai/kingu-intelligence']
      ])
    )
  })

  it('uses the XDG state lock when configured', async () => {
    const root = await temporaryRoot()
    const stateHome = join(root, 'state')
    await mkdir(join(stateHome, 'skills'), { recursive: true })
    await writeFile(
      join(stateHome, 'skills', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: { 'kingu-cli': { source: 'anthovai/kingu-intelligence' } }
      })
    )

    await expect(readSkillLockSources({ homeDir: root, stateHome })).resolves.toEqual(
      new Map([['kingu-cli', 'anthovai/kingu-intelligence']])
    )
  })

  it('reads no sources from a missing or malformed lock', async () => {
    const homeDir = await temporaryRoot()
    await expect(readSkillLockSources({ homeDir, stateHome: null })).resolves.toEqual(new Map())
    await mkdir(join(homeDir, '.agents'), { recursive: true })
    await writeFile(join(homeDir, '.agents', '.skill-lock.json'), '{"skills": []}')
    await expect(readSkillLockSources({ homeDir, stateHome: null })).resolves.toEqual(new Map())
  })
})
