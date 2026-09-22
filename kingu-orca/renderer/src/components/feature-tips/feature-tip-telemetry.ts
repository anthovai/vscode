import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'

export type KinguCliFeatureTipSource = EventProps<'kingu_cli_feature_tip_shown'>['source']
export type KinguCliFeatureTipSetupResult =
  EventProps<'kingu_cli_feature_tip_setup_result'>['result']
export type CmdJPaletteFeatureTipSource = EventProps<'cmd_j_palette_feature_tip_shown'>['source']

export function getKinguCliFeatureTipTelemetrySource(value: unknown): KinguCliFeatureTipSource {
  return value === 'app_open' ? 'app_open' : 'manual'
}

export function trackKinguCliFeatureTipShown(source: KinguCliFeatureTipSource): void {
  track('kingu_cli_feature_tip_shown', { source })
}

export function trackKinguCliFeatureTipSetupClicked(source: KinguCliFeatureTipSource): void {
  track('kingu_cli_feature_tip_setup_clicked', { source })
}

export function trackKinguCliFeatureTipSetupResult(
  source: KinguCliFeatureTipSource,
  result: KinguCliFeatureTipSetupResult
): void {
  track('kingu_cli_feature_tip_setup_result', { source, result })
}

export function trackCmdJPaletteFeatureTipShown(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_shown', { source })
}

export function trackCmdJPaletteFeatureTipAcknowledged(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_acknowledged', { source })
}
