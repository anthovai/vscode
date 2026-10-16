/** Executable entry for `kingud`. See `./kingud-entry.ts`. */
import process from 'node:process'
import { main } from './kingud-entry'
import { resolveKingudExitCode } from './kingud-exit-code'
import { reserveServeStdoutForReadiness } from '../server/serve-stdout-boundary'
import { runKingudNativePreflight } from './kingud-native-preflight'
import {
  KINGUD_PROFILE_PREFLIGHT_FLAG,
  KINGUD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/kingud-profile-preflight'
import {
  preflightBundledKingudStartup,
  runKingudProfilePreflight
} from './kingud-profile-preflight'
import { assertKingudServerRuntime } from './kingud-bundled-runtime'
import {
  formatKingudNativePreflightReport,
  KINGUD_NATIVE_PREFLIGHT_FLAG
} from '../../shared/kingud-native-preflight-report'
import {
  KINGUD_CANCEL_MANAGED_STOP_FLAG,
  KINGUD_COMPLETE_MANAGED_STOP_FLAG
} from '../../shared/kingud-stop-request'
import {
  KINGUD_WINDOWS_BREAKAWAY_CONTRACT,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG
} from '../../shared/windows-breakaway-launch'
import { runWindowsBreakawayLaunchIfRequested } from '../../shared/windows-breakaway-launcher'
import { parseArgs } from './kingud-command-arguments'

// Why exit before the preflight: reaching this line means the whole module graph resolved
// under plain Node, which is all the build guard needs to prove. Probing natives or
// starting a server to prove it would bind a port and take a data-root lock on a build
// machine.
if (process.argv.includes('--kingud-smoke-load-check')) {
  process.exit(0)
}

function failStartup(error: unknown): void {
  console.error('kingud: failed to start:', error)
  // Why a resolved code and not a bare 1: a data-root or bind-address refusal is a
  // configuration fault that restarting cannot fix, and a supervisor needs to tell the two
  // apart to avoid restart-spinning on it.
  process.exit(resolveKingudExitCode(error))
}

// One-shot launch and stop commands must skip server startup and preflights.
if (process.argv[2] === '--kingud-structured-provider-load-check') {
  void import('./kingud-structured-provider-smoke')
    .then(({ smokeLoadKingudStructuredProviders }) => smokeLoadKingudStructuredProviders())
    .then(() => process.exit(0))
    .catch(failStartup)
} else if (process.argv[2] === WINDOWS_BREAKAWAY_LAUNCH_FLAG) {
  runWindowsBreakawayLaunchIfRequested(KINGUD_WINDOWS_BREAKAWAY_CONTRACT, process.argv)
} else if (
  process.argv[2] === KINGUD_COMPLETE_MANAGED_STOP_FLAG ||
  process.argv[2] === KINGUD_CANCEL_MANAGED_STOP_FLAG
) {
  void import('./kingud-managed-stop-command').then(({ runKingudManagedStopCommandAndExit }) =>
    runKingudManagedStopCommandAndExit(process.argv.slice(2))
  )
} else {
  startKingudProcess()
}

function startKingudProcess(): void {
  try {
    const argv = process.argv.slice(2)
    if ((argv.includes('--help') || argv.includes('-h')) && parseArgs(argv).help) {
      void main(argv).catch(failStartup)
      return
    }
    assertKingudServerRuntime()
    const flag = process.argv[2]
    if (flag === KINGUD_NATIVE_PREFLIGHT_FLAG && process.argv.length === 3) {
      void import('./node-pty-precondition').then(({ checkNodePtyPrecondition }) => {
        const verdict = checkNodePtyPrecondition()
        const report = formatKingudNativePreflightReport(verdict.status, verdict.reason ?? null)
        process.stdout.write(`${report}\n`, () => process.exit(0))
      }, failStartup)
    } else if (
      (flag === KINGUD_PROFILE_PREFLIGHT_FLAG || flag === KINGUD_STARTUP_PREFLIGHT_FLAG) &&
      process.argv.length === 4
    ) {
      void runKingudProfilePreflight(process.argv[3], {
        nativeFeatures: flag === KINGUD_PROFILE_PREFLIGHT_FLAG
      })
        // Why exit: the owner reads to EOF, so a lingering native handle must not hold the probe open.
        .then(() => process.stdout.write('', () => process.exit(0)))
        .catch(failStartup)
    } else {
      // Why: stdout is the serve readiness API; incidental diagnostics go to stderr.
      reserveServeStdoutForReadiness()
      void preflightBundledKingudStartup()
        .then(() => {
          // Why: must run before anything requires node-pty; the bundle defers require("node-pty")
          // so no import does. See ./node-pty-precondition.ts.
          runKingudNativePreflight()
          return main()
        })
        .catch(failStartup)
    }
  } catch (error) {
    failStartup(error)
  }
}
