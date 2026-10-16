import { describe, expect, it } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessStatus,
  SkillInstallationTopology
} from '../../shared/skill-freshness'
import { skillUpdateFailedNames } from './skill-update-outcome'

function placement(
  name: string,
  status: SkillFreshnessStatus,
  topology: SkillInstallationTopology = 'canonical-copy'
): SkillFreshnessInstallation {
  return {
    id: `${name}-${topology}-${status}`,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${name}`,
    resolvedPath: `/home/.agents/skills/${name}`,
    physicalIdentity: `physical-${name}`,
    topology,
    status,
    currentPackageDigest: 'current',
    lockSource: 'anthovai/kingu-intelligence',
    errorCategory: null
  }
}

describe('skillUpdateFailedNames', () => {
  it('treats a convergent copy that is now current as landed', () => {
    expect(skillUpdateFailedNames(['kingu-cli'], [placement('kingu-cli', 'current')])).toEqual([])
  })

  it('reports a copy the run left outdated', () => {
    expect(skillUpdateFailedNames(['kingu-cli'], [placement('kingu-cli', 'outdated')])).toEqual([
      'kingu-cli'
    ])
  })

  it('reports an unreadable copy', () => {
    expect(skillUpdateFailedNames(['kingu-cli'], [placement('kingu-cli', 'inaccessible')])).toEqual(
      ['kingu-cli']
    )
  })

  it('reports a skill the run removed outright', () => {
    expect(skillUpdateFailedNames(['kingu-cli'], [])).toEqual(['kingu-cli'])
  })

  it('ignores placements the update command never writes to', () => {
    expect(
      skillUpdateFailedNames(
        ['kingu-cli'],
        [placement('kingu-cli', 'current'), placement('kingu-cli', 'outdated', 'plugin-cache')]
      )
    ).toEqual([])
  })

  it('fails the name when the run leaves a broken link behind', () => {
    expect(
      skillUpdateFailedNames(
        ['kingu-cli'],
        [placement('kingu-cli', 'current'), placement('kingu-cli', 'inaccessible', 'broken-link')]
      )
    ).toEqual(['kingu-cli'])
  })

  it('fails the name when any convergent alias was left behind', () => {
    expect(
      skillUpdateFailedNames(
        ['kingu-cli'],
        [placement('kingu-cli', 'current'), placement('kingu-cli', 'outdated', 'provider-alias')]
      )
    ).toEqual(['kingu-cli'])
  })

  it('judges each requested name independently', () => {
    expect(
      skillUpdateFailedNames(
        ['kingu-cli', 'orchestration'],
        [placement('kingu-cli', 'current'), placement('orchestration', 'outdated')]
      )
    ).toEqual(['orchestration'])
  })
})
