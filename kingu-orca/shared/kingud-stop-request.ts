/**
 * Stop requests for a running kingud, as files beside the process they address.
 *
 * Why files and not signals: a PID can be reused once its process exits, so a signal sent
 * from a stale record can stop an unrelated process. A file in the slot or data root reaches
 * only the kingud that watches it.
 */
import { z } from 'zod'
import { openEnum } from './zod-salvage'

/** Plain request in the slot directory: the same graceful stop as SIGTERM. */
export const KINGUD_STOP_REQUEST_FILENAME = '.kingud-stop-request'
/** Prefix of an instance-bound request in the data root; older listeners never match it. */
export const KINGUD_MANAGED_STOP_REQUEST_PREFIX = '.kingud-managed-stop-request'
export const KINGUD_MANAGED_STOP_REQUEST_MAX_BYTES = 32 * 1024
export const KINGUD_STOP_RECEIPTS_DIRNAME = 'kingud-stop-receipts'
export const KINGUD_COMPLETE_MANAGED_STOP_FLAG = '--complete-managed-stop'
/** Names a staged request file instead of inline JSON; Windows hosts never put the JSON on argv. */
export const KINGUD_MANAGED_STOP_REQUEST_FILE_FLAG = '--request-file'

/** One kingud process: its PID, start time, and the instance lock record it published. */
export const KingudManagedStopInstanceSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /** Linux only, copied from the lock; older clients omit it and older slots drop it. */
  linuxStartTicks: z.string().regex(/^\d+$/).max(32).optional().catch(undefined),
  bootId: z.string().min(1).max(255).optional().catch(undefined),
  nonce: z.string().min(1).max(255),
  lockPath: z.string().min(1).max(4096)
})

// Not strict: the slot's own (possibly older) build parses what a newer client wrote, so an
// unknown optional field is dropped rather than refusing the stop.
export const KingudManagedStopRequestSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.uuid(),
  version: z.string().min(1).max(255),
  runtimeId: z.string().min(1).max(255),
  instance: KingudManagedStopInstanceSchema,
  /** Best effort: also retire the terminal daemon if it is provably idle. Never blocks the stop. */
  retireIdleDaemon: z.literal(true).optional()
})

export type KingudManagedStopInstance = z.infer<typeof KingudManagedStopInstanceSchema>
export type KingudManagedStopRequest = z.infer<typeof KingudManagedStopRequestSchema>

/** Equality key for a request; omits the incarnation, which an older client recovering it drops. */
export function kingudManagedStopRequestKey(request: KingudManagedStopRequest): string {
  const { instance, ...rest } = KingudManagedStopRequestSchema.parse(request)
  const { linuxStartTicks: _ticks, bootId: _bootId, ...bound } = instance
  return JSON.stringify({ ...rest, instance: bound })
}
/** What a stopping kingud must match before a managed request may stop it. */
export type KingudManagedStopContext = Omit<
  KingudManagedStopRequest,
  'schemaVersion' | 'transactionId'
>

const STOP_VERDICTS = ['live', 'unverifiable', 'exited'] as const
const RETIREMENT_VERDICTS = ['retired', 'live', 'unverifiable'] as const

/** The execution host's verdict; `exited` only on proof, never on silence. */
export const KingudManagedStopVerdictSchema = z.enum(STOP_VERDICTS)

/** `retired` only when the daemon accepted; a busy daemon stays up and keeps its terminals. */
export const KingudDaemonRetirementVerdictSchema = z.enum(RETIREMENT_VERDICTS)

// Read by clients older than the slot that printed them: unknown fields and arms degrade.
const stopReplyRequestFields = KingudManagedStopRequestSchema.shape

export const KingudManagedStopCompletionSchema = z.object({
  ...stopReplyRequestFields,
  kind: z.literal('kingud_managed_stop_completion'),
  verdict: openEnum(STOP_VERDICTS, 'unverifiable'),
  receiptPersisted: z.boolean(),
  /** For a request that asked to retire the daemon, the outcome its receipt recorded. */
  retirement: openEnum(RETIREMENT_VERDICTS, 'unverifiable').optional()
})

/** What the stopping kingud observed about its daemon, written before it exits. */
export const KingudDaemonRetirementRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('kingud_managed_stop_retirement'),
  request: KingudManagedStopRequestSchema,
  retirement: KingudDaemonRetirementVerdictSchema,
  liveSessions: z.number().int().nonnegative().nullable(),
  reason: z.string().max(4096).nullable()
})

export const KingudCompletedStopReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('kingud_managed_stop_completed'),
  request: KingudManagedStopRequestSchema,
  exitedAt: z.iso.datetime({ offset: true }),
  /** Present only when the request asked to retire the daemon. */
  retirement: KingudDaemonRetirementVerdictSchema.optional()
})

export type KingudManagedStopVerdict = z.infer<typeof KingudManagedStopVerdictSchema>
export type KingudManagedStopCompletion = z.infer<typeof KingudManagedStopCompletionSchema>
export type KingudCompletedStopReceipt = z.infer<typeof KingudCompletedStopReceiptSchema>
export type KingudDaemonRetirementVerdict = z.infer<typeof KingudDaemonRetirementVerdictSchema>
export type KingudDaemonRetirementRecord = z.infer<typeof KingudDaemonRetirementRecordSchema>

export const KINGUD_CANCEL_MANAGED_STOP_FLAG = '--cancel-managed-stop'
/** Readiness `health.stopRequests`: this build consumes stop files and both commands above. */
export const KINGUD_STOP_REQUESTS_CAPABILITY = 1

/**
 * Which side won a managed request: the running kingud acting on it, or a client cancelling it.
 * Created exclusively once per transaction, so the two can never both believe they won.
 */
export const KingudManagedStopDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('kingud_managed_stop_decision'),
  request: KingudManagedStopRequestSchema,
  decision: z.enum(['dispatched', 'canceled'])
})

/** `dispatched` means kingud already acted on the request; the caller must await its exit. */
export const KingudManagedStopCancellationSchema = z.object({
  ...stopReplyRequestFields,
  kind: z.literal('kingud_managed_stop_cancellation'),
  // Unknown degrades to `dispatched`: the caller then awaits exit rather than assume a cancel.
  outcome: openEnum(['canceled', 'dispatched'], 'dispatched')
})

export type KingudManagedStopDecision = z.infer<typeof KingudManagedStopDecisionSchema>
export type KingudManagedStopCancellation = z.infer<typeof KingudManagedStopCancellationSchema>
