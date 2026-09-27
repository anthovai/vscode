/** Executable entry for `kingud`. See `./kingud-entry.ts`. */
import process from 'node:process'
import { main, resolveKingudExitCode } from './kingud-entry'
import { runKingudNativePreflight } from './kingud-native-preflight'
import {
  KINGUD_PROFILE_PREFLIGHT_FLAG,
  KINGUD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/kingud-profile-preflight'
import {
  preflightBundledKingudStartup,
  runKingudProfilePreflight
} from './kingud-profile-preflight'
import { handoffToBundledKingud } from './kingud-bundled-runtime'

// Why exit before the preflight: reaching this line means the whole module graph resolved
// under plain Node, which is all the build guard needs to prove. Probing natives or
// starting a server to prove it would bind a port and take a data-root lock on a build
// machine.
if (process.argv.includes('--kingud-smoke-load-check')) {
  process.exit(0)
}

// Why here and not inside startKingud: this must run before anything requires node-pty,
// and `kingud-entry` reaches it through `await import('../ipc/pty')`. Static imports are
// evaluated before this statement, so the guarantee is that no module in the graph
// requires node-pty at import time — which the bundle's lazy `require("node-pty")` in
// local-pty-provider satisfies. See ./node-pty-precondition.ts for why a child process.
function failStartup(error: unknown): void {
  console.error('kingud: failed to start:', error)
  // Why a resolved code and not a bare 1: a data-root or bind-address refusal is a
  // configuration fault that restarting cannot fix, and a supervisor needs to tell the two
  // apart to avoid restart-spinning on it.
  process.exit(resolveKingudExitCode(error))
}

try {
  if (!handoffToBundledKingud()) {
    const flag = process.argv[2]
    if (
      (flag === KINGUD_PROFILE_PREFLIGHT_FLAG || flag === KINGUD_STARTUP_PREFLIGHT_FLAG) &&
      process.argv.length === 4
    ) {
      void runKingudProfilePreflight(process.argv[3], {
        nativeFeatures: flag === KINGUD_PROFILE_PREFLIGHT_FLAG
      }).catch(failStartup)
    } else {
      void preflightBundledKingudStartup()
        .then(() => {
          runKingudNativePreflight()
          return main()
        })
        .catch(failStartup)
    }
  }
} catch (error) {
  failStartup(error)
}
