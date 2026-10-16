// Host answers both the desktop sidebar's and the phone's Project grouping tests run on.
import type { MobileProjectSectionCatalog } from './mobile-project-sections-contract'
import type { ExecutionHostId } from './execution-host'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from './project-host-setup-projection'
import type { Repo } from './repo-types'
import type { RuntimeClientTarget } from './runtime-client-target'

const kinguRemote = {
  canonicalKey: 'github.com/anthovai/kingu-intelligence',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:anthovai/kingu-intelligence.git'
}

function hostRepo(id: string, path: string, displayName = 'kingu'): Repo {
  return {
    id,
    path,
    displayName,
    badgeColor: '#737373',
    addedAt: 1,
    ...(displayName === 'kingu' ? { gitRemoteIdentity: kinguRemote } : {})
  }
}

export type ParityHostAnswer = {
  target: RuntimeClientTarget
  hostId: ExecutionHostId
  /** In the host's own repo.list order. */
  repos: Repo[]
  /** The host's project.list/projectHostSetup.list rows; null for a host that predates them. */
  lists: ProjectHostSetupProjection | null
}

const localRepos = [
  hostRepo('local-stably', '/Users/jinwoo/stably/kingu'),
  hostRepo('local-assets', '/Users/jinwoo/design-assets', 'design-assets'),
  hostRepo('local-workspace', '/Users/jinwoo/kingu/workspaces/kingu/kingu')
]
const windowsRepo = hostRepo('win-kingu', 'C:/Users/jinwo/kingu/kingu')

// Jinwoo's shape: several local checkouts of anthovai/kingu-intelligence, plus the project on two servers.
export const PROJECT_SECTION_PARITY_HOSTS: readonly ParityHostAnswer[] = [
  {
    target: { kind: 'local' },
    hostId: 'local',
    repos: localRepos,
    lists: projectHostSetupProjectionFromRepos(localRepos)
  },
  {
    target: { kind: 'environment', environmentId: 'windows2' },
    hostId: 'runtime:windows2',
    repos: [windowsRepo],
    // A server's own catalog rows: its project name and an imported setup on its local host.
    lists: {
      projects: [
        {
          id: 'github:anthovai/kingu-intelligence',
          displayName: 'Kingu',
          badgeColor: '#737373',
          providerIdentity: { provider: 'github', owner: 'anthovai', repo: 'kingu' },
          sourceRepoIds: [windowsRepo.id],
          createdAt: 5,
          updatedAt: 5
        }
      ],
      setups: [
        {
          id: 'win-setup',
          projectId: 'github:anthovai/kingu-intelligence',
          hostId: 'local',
          repoId: windowsRepo.id,
          path: windowsRepo.path,
          displayName: 'kingu',
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 5,
          updatedAt: 5
        }
      ]
    }
  },
  {
    target: { kind: 'environment', environmentId: 'm4air' },
    hostId: 'runtime:m4air',
    repos: [
      hostRepo('m4-kingu', '/Users/m4air/kingu/kingu'),
      hostRepo('m4-kingu-two', '/Users/m4air/kingu-two/kingu')
    ],
    lists: null
  }
]

/** Workspace rows; activity order differs from catalog order, so Recent and Manual disagree. */
export const PROJECT_SECTION_PARITY_ROWS: readonly {
  id: string
  repoId: string
  lastActivityAt: number
}[] = [
  { id: 'wt-m4-two', repoId: 'm4-kingu-two', lastActivityAt: 90 },
  { id: 'wt-win', repoId: 'win-kingu', lastActivityAt: 70 },
  { id: 'wt-workspace', repoId: 'local-workspace', lastActivityAt: 50 },
  { id: 'wt-stably', repoId: 'local-stably', lastActivityAt: 30 },
  { id: 'wt-m4', repoId: 'm4-kingu', lastActivityAt: 10 }
]

const STABLY = {
  key: 'project:github:anthovai/kingu-intelligence::setup:local-stably',
  label: 'jinwoo/stably/kingu'
}
const WORKSPACE = {
  key: 'project:github:anthovai/kingu-intelligence::setup:local-workspace',
  label: 'workspaces/kingu/kingu'
}
// Why 'kingu', not the server's 'Kingu': the later host's derived project name wins the merge.
const WINDOWS = { key: 'project:github:anthovai/kingu-intelligence', label: 'jinwo/kingu/kingu' }
const M4 = {
  key: 'project:github:anthovai/kingu-intelligence::setup:m4-kingu',
  label: 'm4air/kingu/kingu'
}
const M4_TWO = {
  key: 'project:github:anthovai/kingu-intelligence::setup:m4-kingu-two',
  label: 'm4air/kingu-two/kingu'
}
const ASSETS = { key: 'project:repo:local-assets', label: 'design-assets' }

export const PROJECT_SECTION_PARITY_HEADERS = {
  recent: [M4_TWO, WINDOWS, WORKSPACE, STABLY, M4, ASSETS],
  manual: [STABLY, ASSETS, WORKSPACE, WINDOWS, M4, M4_TWO]
} as const

/** What main serves the phone for these answers (the renderer's published catalog). */
export const PROJECT_SECTION_PARITY_SERVED: MobileProjectSectionCatalog = {
  repos: [
    {
      id: 'local-stably',
      displayName: 'kingu',
      path: '/Users/jinwoo/stably/kingu',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'local-assets',
      displayName: 'design-assets',
      path: '/Users/jinwoo/design-assets',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'local-workspace',
      displayName: 'kingu',
      path: '/Users/jinwoo/kingu/workspaces/kingu/kingu',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'win-kingu',
      displayName: 'kingu',
      path: 'C:/Users/jinwo/kingu/kingu',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:windows2'
    },
    {
      id: 'm4-kingu',
      displayName: 'kingu',
      path: '/Users/m4air/kingu/kingu',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:m4air'
    },
    {
      id: 'm4-kingu-two',
      displayName: 'kingu',
      path: '/Users/m4air/kingu-two/kingu',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:m4air'
    }
  ],
  projects: [
    { id: 'repo:local-assets', displayName: 'design-assets' },
    { id: 'github:anthovai/kingu-intelligence', displayName: 'kingu' }
  ],
  setups: [
    {
      id: 'local-stably',
      projectId: 'github:anthovai/kingu-intelligence',
      hostId: 'local',
      repoId: 'local-stably',
      path: '/Users/jinwoo/stably/kingu',
      displayName: 'kingu',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'local-assets',
      projectId: 'repo:local-assets',
      hostId: 'local',
      repoId: 'local-assets',
      path: '/Users/jinwoo/design-assets',
      displayName: 'design-assets',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'local-workspace',
      projectId: 'github:anthovai/kingu-intelligence',
      hostId: 'local',
      repoId: 'local-workspace',
      path: '/Users/jinwoo/kingu/workspaces/kingu/kingu',
      displayName: 'kingu',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'win-setup',
      projectId: 'github:anthovai/kingu-intelligence',
      hostId: 'runtime:windows2',
      repoId: 'win-kingu',
      path: 'C:/Users/jinwo/kingu/kingu',
      displayName: 'kingu',
      setupMethod: 'imported-existing-folder',
      connectionId: null,
      executionHostId: 'runtime:windows2'
    },
    {
      id: 'm4-kingu',
      projectId: 'github:anthovai/kingu-intelligence',
      hostId: 'runtime:m4air',
      repoId: 'm4-kingu',
      path: '/Users/m4air/kingu/kingu',
      displayName: 'kingu',
      setupMethod: 'legacy-repo',
      executionHostId: 'runtime:m4air'
    },
    {
      id: 'm4-kingu-two',
      projectId: 'github:anthovai/kingu-intelligence',
      hostId: 'runtime:m4air',
      repoId: 'm4-kingu-two',
      path: '/Users/m4air/kingu-two/kingu',
      displayName: 'kingu',
      setupMethod: 'legacy-repo',
      executionHostId: 'runtime:m4air'
    }
  ],
  projectOrderBy: 'manual'
}
