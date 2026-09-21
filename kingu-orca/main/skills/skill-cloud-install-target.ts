import type { SkillInstallDestination } from '../../shared/skill-install-contract'
import type { KinguRuntimeService } from '../runtime/kingu-runtime'

export async function classifySkillCloudInstallTarget(
  runtime: KinguRuntimeService,
  input: { environmentId?: string; destination: SkillInstallDestination }
): Promise<'local' | 'remote'> {
  return input.environmentId || (await runtime.skillInstallDestinationUsesSsh(input.destination))
    ? 'remote'
    : 'local'
}
