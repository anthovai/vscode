import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'confirm-kingu-yaml-hooks' as string | null,
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    markKinguHookScriptConfirmed: vi.fn(),
    markKinguHookRepoAlwaysTrusted: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

// Why: fall back to English defaults so this test doesn't depend on locale files
// being loaded; the bug is missing JSX whitespace around those fragments.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function decodeHtml(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

describe('KinguYamlTrustDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'confirm-kingu-yaml-hooks'
    mocks.state.modalData = {
      repoId: 'repo-1',
      repoName: 'kingu',
      scriptKind: 'setup',
      scriptContent: 'node config/scripts/run-internal-dev-setup.mjs\npnpm install',
      contentHash: 'hash-1',
      previouslyApproved: false
    }
  })

  it('keeps spaces around kingu.yaml and the repo name in the first-run copy', async () => {
    const { default: KinguYamlTrustDialog } = await import('./KinguYamlTrustDialog')
    const text = decodeHtml(renderToStaticMarkup(<KinguYamlTrustDialog />)).replace(/<[^>]+>/g, '')

    expect(text).toContain("This repository's kingu.yaml runs on your machine")
    expect(text).toContain('Only run if you trust kingu.')
    expect(text).toContain('Always trust kingu.yaml in kingu')
    expect(text).not.toContain("repository'skingu.yaml")
    expect(text).not.toContain('trustkingu')
    expect(text).not.toContain('trustkingu.yaml')
    expect(text).not.toContain('inkingu')
  })

  it('keeps spaces around kingu.yaml when the script changed since last approval', async () => {
    mocks.state.modalData = {
      ...mocks.state.modalData,
      previouslyApproved: true
    }
    const { default: KinguYamlTrustDialog } = await import('./KinguYamlTrustDialog')
    const text = decodeHtml(renderToStaticMarkup(<KinguYamlTrustDialog />)).replace(/<[^>]+>/g, '')

    expect(text).toContain('kingu.yaml changed since you last approved')
    expect(text).toContain('Always trust kingu.yaml in kingu')
    expect(text).not.toContain('Always trustkingu.yaml')
    expect(text).not.toContain('inkingu')
  })
})
