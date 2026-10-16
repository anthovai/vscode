import { describe, expect, it } from 'vitest'
import {
  canonicalizeSkillUpdateNames,
  type SkillFreshnessInstallation
} from '../../shared/skill-freshness'
import { eligibleSkillUpdateNames } from './skill-freshness-eligibility'

function placement(
  name: string,
  overrides: Partial<SkillFreshnessInstallation> = {}
): SkillFreshnessInstallation {
  return {
    id: `${name}-${overrides.rootId ?? 'home-agents'}`,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${name}`,
    resolvedPath: `/home/.agents/skills/${name}`,
    physicalIdentity: `physical-${name}`,
    topology: 'canonical-copy',
    status: 'outdated',
    currentPackageDigest: 'current',
    lockSource: 'anthovai/kingu-intelligence',
    errorCategory: null,
    ...overrides
  }
}

describe('skill freshness name-scoped update eligibility', () => {
  it('offers a name when at least one supported placement is outdated', () => {
    expect(
      eligibleSkillUpdateNames([
        placement('kingu-cli'),
        placement('kingu-cli', {
          id: 'kingu-cli-claude',
          rootId: 'home-claude',
          topology: 'provider-alias',
          status: 'current'
        })
      ])
    ).toEqual(['kingu-cli'])
  })

  it.each([null, 'acme/agent-skills'])(
    'offers an outdated copy whatever the lock says installed it (%s)',
    (lockSource) => {
      // Why: ownership only decides preselection; #21495 came from gating on the lock.
      expect(eligibleSkillUpdateNames([placement('kingu-cli', { lockSource })])).toEqual([
        'kingu-cli'
      ])
    }
  )

  it.each([
    ['outdated', 'independent-copy'],
    ['current', 'repo-scope'],
    ['outdated', 'repo-scope'],
    ['outdated', 'plugin-cache'],
    ['inaccessible', 'plugin-cache']
  ] as const)(
    'still updates the canonical copy despite a %s placement in %s topology',
    (status, topology) => {
      expect(
        eligibleSkillUpdateNames([
          placement('kingu-cli'),
          placement('kingu-cli', { id: `outlier-${status}-${topology}`, status, topology })
        ])
      ).toEqual(['kingu-cli'])
    }
  )

  it.each(['external-link', 'broken-link', 'read-only'] as const)(
    'skips the name when a home placement is a %s the install would write through',
    (topology) => {
      expect(
        eligibleSkillUpdateNames([
          placement('kingu-cli'),
          placement('kingu-cli', {
            id: `kingu-cli-${topology}`,
            rootId: 'home-claude',
            unresolvedPath: '/home/.claude/skills/kingu-cli',
            topology,
            status: topology === 'broken-link' ? 'inaccessible' : 'outdated'
          })
        ])
      ).toEqual([])
    }
  )

  it('withholds the update when the convergent copy itself is inaccessible', () => {
    expect(
      eligibleSkillUpdateNames([
        placement('kingu-cli', { id: 'blocked-canonical', status: 'inaccessible' }),
        placement('kingu-cli', {
          id: 'kingu-cli-claude',
          rootId: 'home-claude',
          topology: 'provider-alias',
          status: 'outdated'
        })
      ])
    ).toEqual([])
  })

  it('does not promise an update when only a standalone duplicate is outdated', () => {
    expect(
      eligibleSkillUpdateNames([
        placement('orchestration', { status: 'current' }),
        placement('orchestration', {
          id: 'orchestration-factory',
          rootId: 'home-factory',
          unresolvedPath: '/home/.factory/skills/orchestration',
          resolvedPath: '/home/.factory/skills/orchestration',
          physicalIdentity: 'physical-orchestration-factory',
          topology: 'independent-copy',
          status: 'outdated'
        })
      ])
    ).toEqual([])
  })

  it('does not offer a skill that exists only as a standalone copy', () => {
    expect(
      eligibleSkillUpdateNames([
        placement('kingu-cli', {
          rootId: 'home-gemini',
          unresolvedPath: '/home/.gemini/skills/kingu-cli',
          resolvedPath: '/home/.gemini/skills/kingu-cli',
          topology: 'independent-copy'
        })
      ])
    ).toEqual([])
  })

  it('scopes each name independently and leaves an all-current name alone', () => {
    expect(
      eligibleSkillUpdateNames([
        placement('computer-use', { status: 'current' }),
        placement('orchestration'),
        placement('orchestration', { id: 'orchestration-project', topology: 'repo-scope' })
      ])
    ).toEqual(['orchestration'])
  })

  it('canonicalizes only names that are safe to put on a command line', () => {
    expect(canonicalizeSkillUpdateNames(['orchestration', 'kingu-cli', 'kingu-cli'])).toEqual([
      'kingu-cli',
      'orchestration'
    ])
    expect(canonicalizeSkillUpdateNames([])).toBeNull()
    expect(canonicalizeSkillUpdateNames(['kingu-cli;echo unsafe'])).toBeNull()
  })
})
