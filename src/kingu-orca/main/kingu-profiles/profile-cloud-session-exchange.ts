import type {
  KinguCloudCapabilities,
  KinguCloudOrgSummary,
  KinguProfileCloudSummary
} from '../../shared/kingu-profiles'

export type KinguCloudSessionExchangeResponse = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  cloud: KinguProfileCloudSummary
  organizations?: KinguCloudOrgSummary[]
  capabilities: KinguCloudCapabilities
}
