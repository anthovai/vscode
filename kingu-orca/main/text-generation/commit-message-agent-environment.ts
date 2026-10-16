import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import { parseWslUncPath } from '../../shared/wsl-paths'

export type CommitMessageAgentEnvironmentResolvers = {
  prepareForCodexLaunch?: (
    target?: CommitMessageAgentRuntimeTarget
  ) => string | null | Promise<string | null>
  prepareForClaudeLaunch?: (
    target?: CommitMessageAgentRuntimeTarget
  ) => Promise<ClaudeRuntimeAuthPreparation>
  /** The login-shell base env chats start from; a host-only source, never used for WSL. */
  resolveBaseEnvironment?: () => Promise<Record<string, string>>
}

export type CommitMessageAgentRuntimeTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

function cloneProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

// Why: with system-default real-home routing, the headless Codex commit run
// must use the user's own ~/.codex. If Kingu itself was launched from a nested
// Kingu terminal it can inherit an Kingu-owned CODEX_HOME override; strip only
// that (CODEX_HOME matching the private KINGU_CODEX_HOME marker), preserving a
// user-set CODEX_HOME.
function withoutKinguCodexHomeOverride(base: Record<string, string>): Record<string, string> {
  const env = { ...base }
  if (env.KINGU_CODEX_HOME && env.CODEX_HOME === env.KINGU_CODEX_HOME) {
    delete env.CODEX_HOME
  }
  delete env.KINGU_CODEX_HOME
  return env
}

function readInheritedOrShellEnvVar(
  name: string,
  sourceName: string | undefined,
  base: Record<string, string> | undefined
): string | undefined {
  // Why: the login-shell base is what chats use, so it beats Kingu's own inherited value.
  return (
    (sourceName ? process.env[sourceName] : undefined) ??
    base?.[name] ??
    process.env[name] ??
    readShellStartupEnvVar(name, process.env.HOME, process.env.SHELL)
  )
}

function prepareShellConfigDirEnv(
  agentId: string,
  base: Record<string, string> | undefined
): { ok: true; env?: NodeJS.ProcessEnv } | null {
  const configVar =
    agentId === 'opencode' || agentId === 'opencode2'
      ? 'OPENCODE_CONFIG_DIR'
      : agentId === 'pi' || agentId === 'omp'
        ? 'PI_CODING_AGENT_DIR'
        : agentId === 'grok'
          ? 'GROK_HOME'
          : null
  if (!configVar) {
    return null
  }
  // Why: each kind owns a distinct KINGU_*_SOURCE_* shadow so a headless commit
  // run from inside a legacy OMP overlay restores the OMP source dir, never
  // the Pi one (and vice versa). PI_CODING_AGENT_DIR is the binary-facing var
  // both kinds consume — see src/main/pi/titlebar-extension-service.ts.
  const sourceVar =
    agentId === 'opencode' || agentId === 'opencode2'
      ? 'KINGU_OPENCODE_SOURCE_CONFIG_DIR'
      : agentId === 'pi'
        ? 'KINGU_PI_SOURCE_AGENT_DIR'
        : agentId === 'omp'
          ? 'KINGU_OMP_SOURCE_AGENT_DIR'
          : undefined

  const value = readInheritedOrShellEnvVar(configVar, sourceVar, base)
  if (!value) {
    return base ? { ok: true, env: base } : { ok: true }
  }

  // Why: GUI-launched Kingu may not inherit shell startup exports, but these
  // vars point the headless CLI at the user's auth/config root. Nested Kingu
  // launches inherit PTY overlays, so prefer KINGU_*_SOURCE_* when present.
  return { ok: true, env: { ...(base ?? cloneProcessEnv()), [configVar]: value } }
}

async function resolveHostBaseEnv(
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined
): Promise<Record<string, string> | undefined> {
  if (!resolvers?.resolveBaseEnvironment) {
    return undefined
  }
  try {
    return { ...(await resolvers.resolveBaseEnvironment()) }
  } catch (error) {
    console.error('[commit-message] Failed to resolve the login-shell environment:', error)
    return undefined
  }
}

export async function prepareLocalCommitMessageAgentEnv(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  target?: CommitMessageAgentRuntimeTarget
): Promise<{ ok: true; env?: NodeJS.ProcessEnv } | { ok: false; error: string }> {
  // Why: a Dock-launched Kingu lacks the user's shell exports (proxy URLs, tokens); WSL
  // resolves env in the guest, so it keeps Kingu's own env.
  const hostBase = target?.runtime === 'wsl' ? undefined : await resolveHostBaseEnv(resolvers)
  // Why: a non-null result short-circuits the resolvers below, so any agent added
  // to prepareShellConfigDirEnv must not also need a Codex/Claude-style resolver.
  const shellConfigEnv =
    target?.runtime === 'wsl' ? null : prepareShellConfigDirEnv(agentId, hostBase)
  if (shellConfigEnv) {
    return shellConfigEnv
  }
  if (!resolvers) {
    return { ok: true }
  }
  const base = hostBase ?? cloneProcessEnv()

  try {
    if (agentId === 'codex' && resolvers.prepareForCodexLaunch) {
      const codexHomePath = await resolvers.prepareForCodexLaunch(target)
      const wslCodexHome = codexHomePath ? parseWslUncPath(codexHomePath) : null
      if (target?.runtime === 'wsl') {
        const codexHomeForTarget = wslCodexHome?.linuxPath ?? null
        // Why: the fallback must still strip Kingu-owned overrides, or a
        // system-default WSL run inherits the managed CODEX_HOME.
        return {
          ok: true,
          env: codexHomeForTarget
            ? { ...withoutKinguCodexHomeOverride(base), CODEX_HOME: codexHomeForTarget }
            : withoutKinguCodexHomeOverride(base)
        }
      }
      if (codexHomePath && wslCodexHome) {
        // Why: this local generation path spawns the host Codex binary. A WSL
        // managed home is only valid when the process is routed through wsl.exe.
        return hostBase ? { ok: true, env: hostBase } : { ok: true }
      }
      return {
        ok: true,
        env: codexHomePath
          ? { ...base, CODEX_HOME: codexHomePath }
          : withoutKinguCodexHomeOverride(base)
      }
    }

    if (agentId === 'claude' && resolvers.prepareForClaudeLaunch) {
      const preparation = await resolvers.prepareForClaudeLaunch(target)
      const env = applyClaudeEnvPatch({ ...base }, preparation.envPatch)
      return { ok: true, env }
    }
  } catch (error) {
    console.error('[commit-message] Failed to prepare agent environment:', error)
    return {
      ok: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    }
  }

  return hostBase ? { ok: true, env: hostBase } : { ok: true }
}
