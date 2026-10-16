/**
 * `kingud` — the Kingu runtime served without Electron.
 *
 * Installs the Node host adapters, constructs the same `KinguRuntimeService` the
 * desktop uses, installs a PTY controller via `registerHeadlessPtyRuntime`, and
 * serves runtime RPC. See docs/design/node-only-runtime-backend.html.
 *
 * Desktop UI surfaces stay uninstalled: no native notifications or renderer delivery.
 * Browser automation is installed through
 * the runtime factory, but only when an Electron serve sidecar or an operator-supplied
 * Chromium proves available at startup.
 */
import process from 'node:process'
import { getAppEnvironment } from '../../shared/app-environment'
import type { ServeReadiness } from '../server/serve-readiness'
import { resolveKingudInstallRoot, resolveUserDataPath } from './kingud-app-paths'
import { prepareKingudCliLauncher } from './kingud-cli-launcher'
import { installKingudHostAdapters, runKingudQuitHandlers } from './kingud-host-adapters'
import { describeKingudBindExposure, resolveKingudBindHost } from './kingud-bind-address'
import {
  flushKingudProfileStoreForShutdown,
  installKingudShutdownSignals,
  startKingudWithHost
} from './kingud-lifecycle'
import { KINGUD_USAGE, parseArgs } from './kingud-command-arguments'
import type { KingudRuntimeCleanup } from './kingud-runtime-lifetime'
import { installKingudStopRequestListeners } from './kingud-stop-request-listener'
import { prepareKingudManagedStop } from './kingud-managed-stop-admission'
import type { KingudManagedStopContext } from '../../shared/kingud-stop-request'
import { beginKingudIdleExit, bindKingudIdleShutdown } from './kingud-managed-idle-exit-host'
import { kingudAutomationsKeepHostBusy, startKingudAutomations } from './kingud-automations'
import {
  changedAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import { stampRuntimeSourceEnv } from '../../shared/runtime-source-env'
import { adoptWslHostLoginEnvironment } from './kingud-wsl-host-login-environment'

export { parseArgs }

let closeKingudObservability = (): void => {}

export type KingudOptions = {
  port?: number
  json?: boolean
  noPairing?: boolean
  pairingAddress?: string
  /** Desktop `kingu serve` parity: a mobile-scoped offer with a terminal QR. */
  mobilePairing?: boolean
  /** Lets the paired runtime client drive this machine's desktop (computer.*). */
  grantDesktopControl?: boolean
  /** Desktop `kingu serve` parity: print only the ephemeral-VM recipe line. */
  recipeJson?: boolean
  projectRoot?: string
  /** Literal IP to bind. Defaults to loopback; see kingud-bind-address.ts. */
  bind?: string
}

export type KingudHandle = {
  readiness: ServeReadiness
  /** What an instance-bound stop request must name to stop this process. */
  managedStop: KingudManagedStopContext
  stop(): Promise<void>
}

/**
 * Boot the runtime and serve RPC. Resolves once the transport is listening and the
 * readiness payload has been published, mirroring the desktop `--serve` contract byte
 * for byte so the same harnesses can drive either host.
 */
export async function startKingud(options: KingudOptions = {}): Promise<KingudHandle> {
  installKingudHostAdapters()
  // Why: an kingud started from an Kingu terminal must not fence its own CLI children to that Kingu.
  stampRuntimeSourceEnv(process.env, null)
  const userDataPath = resolveUserDataPath()
  // Why, as on the desktop: an inherited value would aim the CLI-shared Codex home paths elsewhere.
  process.env.KINGU_USER_DATA_PATH = userDataPath
  const { readiness, instance, stop } = await startKingudWithHost(
    userDataPath,
    (registerCleanup) => startKingudRuntime(options, registerCleanup),
    () => {
      try {
        runKingudQuitHandlers()
      } finally {
        // Last, after every quit handler (even a failing one), so their spans still reach the file.
        closeKingudObservability()
        closeKingudObservability = () => {}
      }
    }
  )
  const version = getAppEnvironment().getVersion()
  return { readiness, managedStop: { version, runtimeId: readiness.runtimeId, instance }, stop }
}

async function startKingudRuntime(
  options: KingudOptions,
  registerCleanup: (cleanup: KingudRuntimeCleanup) => void
): Promise<Pick<KingudHandle, 'readiness'>> {
  // Started first so the login-shell probe overlaps the imports and store startup below.
  const loginEnvironment = adoptWslHostLoginEnvironment().then(
    (names) => {
      if (names.length > 0) {
        console.info(`[kingud] adopted login-shell variables: ${names.join(', ')}`)
      }
    },
    (error: unknown) => console.warn('[kingud] could not adopt login-shell variables:', error)
  )
  const { KinguRuntimeService } = await import('../runtime/kingu-runtime')
  const { KinguRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime } = await import('../ipc/pty/register-headless-runtime')
  const { getLocalPtyProvider } = await import('../ipc/pty/provider/registry')
  const { installKingudObservability } = await import('./kingud-observability')
  closeKingudObservability = installKingudObservability()
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { servePublishMode } = await import('../server/serve-pairing-readiness')
  const { buildKingudServeReadiness } = await import('./kingud-serve-readiness')
  const { createKingudProfileStateStartup } = await import('./kingud-profile-state-startup')
  const { startKingudDaemon, stopKingudDaemon } = await import('./kingud-daemon-supervision')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-provider-state')
  const { collectKingudHealth } = await import('./kingud-health')
  // Why importable here: the singleton's module tree never reaches Electron, and kingud supplies
  // its persistence and endpoint paths explicitly below.
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { agentHookRuntimeDeps } = await import('../agent-hooks/agent-hook-runtime-deps')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { startKingudManagedAgentHooks } = await import('./kingud-managed-agent-hooks')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')

  const { disposeWatcherProcessAndWait } = await import('../ipc/parcel-watcher-process')

  let profileStoreForShutdown:
    | { flushFinalOrThrowAsync(): Promise<void>; freezeWritesAsync(): Promise<void> }
    | undefined
  let uninstallHookStatusRepublish = (): void => {}
  let uninstallObservedStatusIdentity = (): void => {}
  // Cleanups run in reverse: RPC, then recovery and watchers, then the final flush, then daemon.
  registerCleanup(() => agentHookServer.stop())
  registerCleanup(() => uninstallHookStatusRepublish())
  registerCleanup(() => uninstallObservedStatusIdentity())
  // Why disconnect and not shut down: the daemon must outlive this process, or an kingud
  // restart goes back to killing every running terminal.
  registerCleanup(() => stopKingudDaemon())
  registerCleanup(async () => {
    // A SQLite-backed kingud has no JSON mirror to absorb a debounced write after SIGTERM.
    if (profileStoreForShutdown) {
      await flushKingudProfileStoreForShutdown(profileStoreForShutdown)
    }
  })
  // Watcher children outlive a disposal that does not wait for them.
  registerCleanup(() => disposeWatcherProcessAndWait())
  const { DesktopPushService } = await import('../runtime/push/desktop-push-service')
  const { resolvePushGatewayOrigin } = await import('../runtime/push/push-gateway-origin')

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  const { startEventLoopDelayProbe } = await import('../diagnostics/event-loop-delay-probe')
  startEventLoopDelayProbe('kingud', runtimeUserDataPath)
  // A missing `kingu` command must never keep the server from starting.
  await prepareKingudCliLauncher().catch((error: unknown) => {
    console.warn('[kingud] Could not prepare the profile CLI launcher', error)
  })
  const idleExitStartup = beginKingudIdleExit(runtimeUserDataPath)
  const { store: profileStore, authority: profileStateAuthority } =
    await createKingudProfileStateStartup(runtimeUserDataPath)
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  profileStoreForShutdown = profileStore
  uninstallObservedStatusIdentity = agentHookServer.subscribeEnrichedStatus((enriched) =>
    observedStatusCapture.observe(enriched)
  )
  await agentHookServer.start({
    env: 'production',
    userDataPath: runtimeUserDataPath,
    statusHooksEnabled: isAgentStatusHooksEnabled(profileStore.getSettings())
  })

  // Before hook reconcile, the daemon and the runtime: each reads or inherits this env.
  await loginEnvironment
  startKingudManagedAgentHooks(
    profileStore,
    (enabled) => agentHookServer.setStatusHooksEnabled(enabled),
    registerCleanup
  )

  // Why before the runtime and the PTY handlers: `setLocalPtyProvider` installs the daemon
  // adapter as THE local provider, and the registry's contract is that it lands before
  // registerPtyHandlers so the IPC layer routes through the daemon from the first call.
  await startKingudDaemon()

  // Why a holder and not a direct reference: the index is installed after the runtime is
  // constructed, and the deps hook is only ever called later, from an RPC.
  let sessionSearch: { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null = null

  const { kingudCodexAccountHomes } = await import('./kingud-codex-account-homes')
  const codexAccountHomes = kingudCodexAccountHomes(
    () => profileStore.getSettings(),
    registerCleanup
  )

  // Why before the runtime: its structured Codex resolvers are constructor deps.
  const { createKingudAccountServices } = await import('./kingud-account-services')
  const accountLaunch = createKingudAccountServices({
    store: profileStore,
    setClaudeStatusLineListener: (listener) =>
      agentHookServer.setClaudeStatusLineListener(listener),
    registerCleanup,
    clientCodexHomes: codexAccountHomes
  })

  const runtime = new KinguRuntimeService(profileStore, undefined, {
    getAdditionalAiVaultCodexHomePaths: () => [
      ...codexAccountHomes.listSessionHomes(),
      ...(accountLaunch?.listCodexSessionHomes() ?? [])
    ],
    // Why absent on a WSL host: a resolver overrides the desktop-pushed CODEX_HOME.
    ...accountLaunch?.runtimeDeps,
    // Why here too: kingud serves `worktree.ps` and `agentSession.*`; unwired it lists no agents.
    ...agentHookRuntimeDeps(agentHookServer, observedPaneIdentities, () =>
      profileStore.getSettings()
    ),
    // Why lazy: a daemon swap replaces the provider after construction, so an eager
    // reference would freeze the pre-daemon one.
    getLocalProvider: () => getLocalPtyProvider(),
    // Why the daemon predicate and not a constant: kingud now spawns the terminal daemon, so
    // its PTYs DO survive an kingud restart — but only while a daemon that owns fresh
    // sessions is installed. A failed or degraded launch has to answer false, and this reads
    // that live rather than snapshotting it at construction.
    canRecoverPersistentLocalPtys: () => daemonOwnsFreshPersistentPtys(),
    // Why 'blocked': `'openable'` means a desktop window can be opened here, which is
    // what powers serve→desktop promotion. A Node host can never do that, and the
    // constructor's default would advertise it.
    getDesktopWindowStatus: () => 'blocked',
    // Why the dedupe here and not in the instance: `apply` closes and reconstructs
    // unconditionally, so an unchanged value would restart a healthy index.
    applySessionSearchSettings: (before, after) => {
      const next = changedAiVaultSearchSettings(before, after)
      if (next) {
        sessionSearch?.apply(next)
      }
    }
  })

  accountLaunch?.attachToRuntime(runtime)

  // Why before any launch: a desktop that owns this host's accounts pushed them on an earlier run.
  const { restoreKingudHostAccountLaunchEnv } =
    await import('./kingud-host-account-launch-env-store')
  restoreKingudHostAccountLaunchEnv(runtime, runtimeUserDataPath)

  const { installKingudSessionSearchService } = await import('./kingud-session-search')
  sessionSearch = await installKingudSessionSearchService({
    userDataPath: runtimeUserDataPath,
    getSettings: () => profileStore.getSettings()
  })
  getAppEnvironment().onWillQuit(() => sessionSearch?.dispose())

  // Why: this host evaluates its own panes, so it keeps its own rules current.
  const { startAgentStateRulesLiveUpdates } =
    await import('../runtime/agent-state-rules/agent-state-rules-live-update')
  startAgentStateRulesLiveUpdates(profileStore, (rules) =>
    console.info(`[kingud] agent state rules ${rules.version} (${rules.source})`)
  )

  // Why here too and not only on the desktop: nothing else republishes `session.tabs` when a
  // pane's status row changes, and kingud's whole job is serving paired clients.
  uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => runtime
  )

  // Why the headless entry point rather than registerPtyHandlers directly: this is the
  // same call `--serve` makes, and it threads the store through. Without the store the
  // handlers install fine and every terminal.create then fails at persistence time.
  //
  // A client-sent Codex account home wins; otherwise this host's own selection applies. A WSL host
  // has none: its desktop sends the prepared account env.
  await registerHeadlessPtyRuntime(
    runtime,
    async (target, launchEnv, context) =>
      (await codexAccountHomes.selectLaunchHome(target, launchEnv, context)) ??
      (accountLaunch ? accountLaunch.prepareCodexHome(target, launchEnv, context) : null),
    () => profileStore.getSettings(),
    accountLaunch?.prepareClaudeAuth,
    profileStore,
    accountLaunch?.prepareCodexSessionResume
  )

  // Why: same post-registration reconciliation `--serve` performs. Skipping it leaves
  // restored orchestration rows claiming an authority this host never took over.
  // Why before the RPC server binds: a client host attaching first would find no pages to recover.
  runtime.rehydrateClientHostedBrowserPages()

  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()

  // Runs after RPC stops (cleanups run reversed); later records save synchronously until exit.
  registerCleanup(() => runtime.closeNotificationDismissals())
  // A retry armed during recovery would otherwise write after the final profile flush.
  registerCleanup(() => runtime.stopLegacyWorkerTerminalRecovery())

  // Recovery binds terminal and dispatch identities; only now can startup observations be fenced.
  observedStatusCapture.attach(runtime)
  // Why before the RPC server binds: like `--serve`, the first client must find a ready graph.
  const { publishHeadlessRuntimeGraph } = await import('../runtime/headless-runtime-graph')
  publishHeadlessRuntimeGraph(runtime)
  // Store load skipped moved shell history: only the runtime can tell which worktrees run a shell.
  void runtime.installPendingKingudMigrationShellHistory().catch((error: unknown) => {
    console.error('[kingud-migration] installing pending shell history failed:', error)
  })

  const bindHost = resolveKingudBindHost(options.bind)
  const rpc = new KinguRuntimeRpcServer({
    runtime,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Why pinned and not `exposeNetworkByDefault`: an unattended host's exposure must be
    // exactly what the operator asked for, on every launch. The default path widens itself
    // once a device has connected, so a loopback deployment would silently go wide one
    // restart after its first client paired.
    pinnedBindHost: bindHost,
    ...(options.port !== undefined ? { wsPort: options.port, preferPinnedWsPort: true } : {})
  })
  // Stops first: no RPC may write while the rest of the runtime is torn down.
  registerCleanup(() => rpc.stop())
  await rpc.start()
  startKingudAutomations(runtime, profileStore, registerCleanup)
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc: rpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  pushService?.start()
  getAppEnvironment().onWillQuit(() => pushService?.stop())
  console.error(`[kingud] ${describeKingudBindExposure(bindHost)}`)

  const readiness = await buildKingudServeReadiness({
    options,
    runtimeId: runtime.getRuntimeId(),
    rpc,
    collectHealth: () =>
      collectKingudHealth(
        getAppEnvironment().getVersion(),
        profileStateAuthority,
        idleExitStartup.previousIdleStop
      )
  })

  await new ServeReadinessPublisher().publish(readiness, servePublishMode(options))

  await idleExitStartup.start({
    rpc,
    agentStates: () => agentHookServer.getStatusSnapshot(),
    hasStagedMigration: () => profileStore.hasStagedKingudMigrationCatalog(),
    automationsBusy: () => kingudAutomationsKeepHostBusy(profileStore),
    registerCleanup
  })
  return { readiness }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(KINGUD_USAGE)
    return
  }
  const startup = startKingud(options)
  const requestShutdown = installKingudShutdownSignals(async () => (await startup).stop())
  const handle = await startup
  // Why after startup: a managed request must name the runtime and instance this run became.
  installKingudStopRequestListeners(() => requestShutdown('stop request'), {
    installRoot: resolveKingudInstallRoot(),
    managedStop: handle.managedStop,
    beforeManagedStop: prepareKingudManagedStop
  })
  bindKingudIdleShutdown(requestShutdown)
}
