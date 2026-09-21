// Why: the pty IPC suites force darwin and rewrite a dozen agent-home env vars per test;
// this scope captures the real values once and puts them back afterwards.
export function createPtyIpcProcessEnvScope() {
  const savedOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  const savedKinguOpenCodeConfigDir = process.env.KINGU_OPENCODE_CONFIG_DIR
  const savedKinguOpenCodeSourceConfigDir = process.env.KINGU_OPENCODE_SOURCE_CONFIG_DIR
  const savedPiAgentDir = process.env.PI_CODING_AGENT_DIR
  const savedKinguPiAgentDir = process.env.KINGU_PI_CODING_AGENT_DIR
  const savedKinguPiSourceAgentDir = process.env.KINGU_PI_SOURCE_AGENT_DIR
  const savedKinguCodexHome = process.env.KINGU_CODEX_HOME
  const savedKinguOmpAgentDir = process.env.KINGU_OMP_CODING_AGENT_DIR
  const savedKinguOmpSourceAgentDir = process.env.KINGU_OMP_SOURCE_AGENT_DIR
  const savedKinguOmpStatusExtension = process.env.KINGU_OMP_STATUS_EXTENSION
  const savedPrimeAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
  const savedKinguPrimeAgentSourceDir = process.env.KINGU_PRIME_AGENT_SOURCE_AGENT_DIR
  const savedKinguPrimeAgentStatusExtension = process.env.KINGU_PRIME_AGENT_STATUS_EXTENSION
  const savedKinguClaudeAgentStatusSettings = process.env.KINGU_CLAUDE_AGENT_STATUS_SETTINGS
  const savedProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const savedDisableMacosLoginShell = process.env.KINGU_DISABLE_MACOS_LOGIN_SHELL
  const savedKinguUserDataPath = process.env.KINGU_USER_DATA_PATH

  function applyTestEnvDefaults() {
    // Why: most PTY spawn tests assert POSIX shell behavior; Windows cases opt into win32 explicitly below.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Why: forced darwin makes the TCC login(1) wrapper rewrite every asserted argv; its own test below re-enables it.
    process.env.KINGU_DISABLE_MACOS_LOGIN_SHELL = '1'
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.KINGU_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.KINGU_OPENCODE_CONFIG_DIR
    delete process.env.KINGU_AGENT_HOOK_ENDPOINT
    delete process.env.KINGU_CLAUDE_AGENT_STATUS_SETTINGS
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.KINGU_PI_SOURCE_AGENT_DIR
    delete process.env.KINGU_PI_CODING_AGENT_DIR
    delete process.env.KINGU_CODEX_HOME
    delete process.env.KINGU_OMP_SOURCE_AGENT_DIR
    delete process.env.KINGU_OMP_CODING_AGENT_DIR
    delete process.env.KINGU_OMP_STATUS_EXTENSION
    delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    delete process.env.KINGU_PRIME_AGENT_SOURCE_AGENT_DIR
    delete process.env.KINGU_PRIME_AGENT_STATUS_EXTENSION
  }

  function restoreProcessEnv() {
    if (savedProcessPlatform) {
      Object.defineProperty(process, 'platform', savedProcessPlatform)
    }
    if (savedDisableMacosLoginShell !== undefined) {
      process.env.KINGU_DISABLE_MACOS_LOGIN_SHELL = savedDisableMacosLoginShell
    } else {
      delete process.env.KINGU_DISABLE_MACOS_LOGIN_SHELL
    }
    if (savedKinguUserDataPath !== undefined) {
      process.env.KINGU_USER_DATA_PATH = savedKinguUserDataPath
    } else {
      delete process.env.KINGU_USER_DATA_PATH
    }
    if (savedOpenCodeConfigDir !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = savedOpenCodeConfigDir
    } else {
      delete process.env.OPENCODE_CONFIG_DIR
    }
    if (savedKinguOpenCodeConfigDir !== undefined) {
      process.env.KINGU_OPENCODE_CONFIG_DIR = savedKinguOpenCodeConfigDir
    } else {
      delete process.env.KINGU_OPENCODE_CONFIG_DIR
    }
    if (savedKinguOpenCodeSourceConfigDir !== undefined) {
      process.env.KINGU_OPENCODE_SOURCE_CONFIG_DIR = savedKinguOpenCodeSourceConfigDir
    } else {
      delete process.env.KINGU_OPENCODE_SOURCE_CONFIG_DIR
    }
    if (savedPiAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = savedPiAgentDir
    } else {
      delete process.env.PI_CODING_AGENT_DIR
    }
    if (savedKinguPiAgentDir !== undefined) {
      process.env.KINGU_PI_CODING_AGENT_DIR = savedKinguPiAgentDir
    } else {
      delete process.env.KINGU_PI_CODING_AGENT_DIR
    }
    if (savedKinguPiSourceAgentDir === undefined) {
      delete process.env.KINGU_PI_SOURCE_AGENT_DIR
    } else {
      process.env.KINGU_PI_SOURCE_AGENT_DIR = savedKinguPiSourceAgentDir
    }
    if (savedKinguCodexHome === undefined) {
      delete process.env.KINGU_CODEX_HOME
    } else {
      process.env.KINGU_CODEX_HOME = savedKinguCodexHome
    }
    if (savedKinguOmpAgentDir !== undefined) {
      process.env.KINGU_OMP_CODING_AGENT_DIR = savedKinguOmpAgentDir
    } else {
      delete process.env.KINGU_OMP_CODING_AGENT_DIR
    }
    if (savedKinguOmpSourceAgentDir !== undefined) {
      process.env.KINGU_OMP_SOURCE_AGENT_DIR = savedKinguOmpSourceAgentDir
    } else {
      delete process.env.KINGU_OMP_SOURCE_AGENT_DIR
    }
    if (savedKinguOmpStatusExtension !== undefined) {
      process.env.KINGU_OMP_STATUS_EXTENSION = savedKinguOmpStatusExtension
    } else {
      delete process.env.KINGU_OMP_STATUS_EXTENSION
    }
    if (savedPrimeAgentDir !== undefined) {
      process.env.PRIME_AGENT_CODING_AGENT_DIR = savedPrimeAgentDir
    } else {
      delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    }
    if (savedKinguPrimeAgentSourceDir !== undefined) {
      process.env.KINGU_PRIME_AGENT_SOURCE_AGENT_DIR = savedKinguPrimeAgentSourceDir
    } else {
      delete process.env.KINGU_PRIME_AGENT_SOURCE_AGENT_DIR
    }
    if (savedKinguPrimeAgentStatusExtension !== undefined) {
      process.env.KINGU_PRIME_AGENT_STATUS_EXTENSION = savedKinguPrimeAgentStatusExtension
    } else {
      delete process.env.KINGU_PRIME_AGENT_STATUS_EXTENSION
    }
    if (savedKinguClaudeAgentStatusSettings === undefined) {
      delete process.env.KINGU_CLAUDE_AGENT_STATUS_SETTINGS
    } else {
      process.env.KINGU_CLAUDE_AGENT_STATUS_SETTINGS = savedKinguClaudeAgentStatusSettings
    }
  }

  return { applyTestEnvDefaults, restoreProcessEnv }
}
