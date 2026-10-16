/** What to suggest when a server cannot be reached, chosen by the kind of host that owns it. */
import { withRemoteRuntimeTailscaleHint } from '../../shared/remote-runtime-tailscale-hint'
import {
  isWslHostRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'

const UNREACHABLE_RE =
  /could not connect to the remote kingu runtime|remote kingu runtime closed the connection|timed out (?:waiting for|while connecting to) the remote kingu runtime/i

export function withRuntimeUnreachableHint(
  environment: Pick<KnownRuntimeEnvironment, 'kingudDeployment'>,
  message: string,
  endpoint: string | null | undefined
): string {
  if (!isWslHostRuntimeEnvironment(environment)) {
    return withRemoteRuntimeTailscaleHint(message, endpoint)
  }
  // Why not Tailscale: a WSL host is a distro on this computer, reached over wsl.exe.
  return UNREACHABLE_RE.test(message)
    ? `${message} The Kingu server in the WSL distro ${environment.kingudDeployment.distro} isn’t answering; connect it again in Settings → Remote Kingu Servers → WSL hosts.`
    : message
}
