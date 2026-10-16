/**
 * `kingud --complete-managed-stop <request-json>`: one stop, one JSON verdict line on stdout.
 * `kingud --cancel-managed-stop <request-json>`: one cancellation, one JSON outcome line.
 * Either takes `--request-file <path>` in place of the JSON.
 *
 * Exit 0 means a result was printed — read it, the exit code does not carry it. 64 is a
 * malformed invocation; 1 is a failure before any result, which is never evidence of exit.
 */
import {
  KINGUD_CANCEL_MANAGED_STOP_FLAG,
  KINGUD_COMPLETE_MANAGED_STOP_FLAG,
  KINGUD_MANAGED_STOP_REQUEST_FILE_FLAG,
  KingudManagedStopRequestSchema,
  type KingudManagedStopCancellation,
  type KingudManagedStopCompletion,
  type KingudManagedStopRequest
} from '../../shared/kingud-stop-request'
import { cancelKingudManagedStop } from './kingud-managed-stop-cancellation'
import { readKingudCompletedStopReceipt } from './kingud-completed-stop-receipt'
import { readKingudManagedStopRequest } from './kingud-managed-stop-request'
import { ZodError } from 'zod'
import {
  completeKingudManagedStop,
  type KingudManagedStopCompletionOptions
} from './kingud-managed-stop-completion'

export async function runKingudManagedStopCommand(
  argv: readonly string[],
  options: KingudManagedStopCompletionOptions = {}
): Promise<KingudManagedStopCompletion> {
  const request = parseRequestArgument(argv, KINGUD_COMPLETE_MANAGED_STOP_FLAG)
  const verdict = await completeKingudManagedStop(request, options)
  const retirement =
    verdict === 'exited' && request.retireIdleDaemon
      ? readKingudCompletedStopReceipt(request)?.retirement
      : undefined
  const completion: KingudManagedStopCompletion = {
    ...request,
    kind: 'kingud_managed_stop_completion',
    verdict,
    receiptPersisted: verdict === 'exited',
    ...(retirement ? { retirement } : {})
  }
  process.stdout.write(`${JSON.stringify(completion)}\n`)
  return completion
}

export function runKingudManagedStopCancelCommand(
  argv: readonly string[]
): KingudManagedStopCancellation {
  const request = parseRequestArgument(argv, KINGUD_CANCEL_MANAGED_STOP_FLAG)
  const cancellation: KingudManagedStopCancellation = {
    ...request,
    kind: 'kingud_managed_stop_cancellation',
    outcome: cancelKingudManagedStop(request)
  }
  process.stdout.write(`${JSON.stringify(cancellation)}\n`)
  return cancellation
}

function parseRequestArgument(argv: readonly string[], flag: string): KingudManagedStopRequest {
  if (argv[0] !== flag) {
    throw new Error('kingud_managed_stop_invalid_arguments')
  }
  if (argv[1] === KINGUD_MANAGED_STOP_REQUEST_FILE_FLAG) {
    if (argv.length !== 3 || !argv[2]) {
      throw new Error('kingud_managed_stop_invalid_arguments')
    }
    return readKingudManagedStopRequest(argv[2])
  }
  if (argv.length !== 2 || !argv[1]) {
    throw new Error('kingud_managed_stop_invalid_arguments')
  }
  return KingudManagedStopRequestSchema.parse(JSON.parse(argv[1]))
}

export const KINGUD_MANAGED_STOP_EXIT_VERDICT = 0
export const KINGUD_MANAGED_STOP_EXIT_FAILED = 1
export const KINGUD_MANAGED_STOP_EXIT_USAGE = 64

export async function runKingudManagedStopCommandAndExit(argv: readonly string[]): Promise<void> {
  let code = KINGUD_MANAGED_STOP_EXIT_VERDICT
  try {
    if (argv[0] === KINGUD_CANCEL_MANAGED_STOP_FLAG) {
      runKingudManagedStopCancelCommand(argv)
    } else {
      await runKingudManagedStopCommand(argv)
    }
  } catch (error) {
    console.error('kingud: managed stop failed:', error)
    code =
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      (error instanceof Error && error.message === 'kingud_managed_stop_invalid_arguments')
        ? KINGUD_MANAGED_STOP_EXIT_USAGE
        : KINGUD_MANAGED_STOP_EXIT_FAILED
  }
  // Why exit after the write drains: the caller reads stdout to EOF.
  process.stdout.write('', () => process.exit(code))
}
