import { describe, expect, it } from 'vitest'
import { parseSkillShareId } from './skill-share-link'

describe('parseSkillShareId', () => {
  it('accepts durable Kingu links and bare identifiers', () => {
    expect(parseSkillShareId('share_123')).toBe('share_123')
    expect(parseSkillShareId('https://app.kingu.dev/skills/share/share_123')).toBe('share_123')
    expect(parseSkillShareId('https://share.onkingu.dev/skills/share/share_123/')).toBe('share_123')
    expect(parseSkillShareId('kingu://skills/share/share_123')).toBe('share_123')
  })

  it('rejects attacker origins and lookalike paths', () => {
    expect(parseSkillShareId('https://attacker.test/skills/share/share_123')).toBeNull()
    expect(parseSkillShareId('https://app.kingu.dev/skills/share/share_123/more')).toBeNull()
    expect(parseSkillShareId('javascript:share_123')).toBeNull()
  })
})
