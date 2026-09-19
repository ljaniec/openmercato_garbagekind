import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { PhysicalIntent } from '../../data/entities'
import {
  evaluateAuthorizationGrant,
  evaluateBusinessPrecondition,
  evaluateDeterministicPolicy,
  evaluateExecutorCapability,
  evaluateExecutorCredential,
} from './providers'
import { finalizeGate, type GateEvaluation } from './types'

export type EvaluateRealityGateArgs = Readonly<{
  em: EntityManager
  ctx: CommandRuntimeContext
  intent: PhysicalIntent
  executorId: string
  now?: Date
}>

/**
 * Evaluate every independent trust claim and retain the full verdict vector.
 *
 * Deliberately sequential. These checks are operational decisions rather than
 * a throughput path, and a stable evaluation order makes audit/debug output
 * reproducible while avoiding concurrent use of one request EntityManager.
 */
export async function evaluateRealityGate(
  args: EvaluateRealityGateArgs,
): Promise<GateEvaluation> {
  const now = args.now ?? new Date()
  const context = { intent: args.intent, executorId: args.executorId, now }

  const business = await evaluateBusinessPrecondition(args.em, context)
  const capability = await evaluateExecutorCapability(args.em, context)
  const credential = await evaluateExecutorCredential(args.em, context)
  const authorization = await evaluateAuthorizationGrant(args.em, context)
  const policy = await evaluateDeterministicPolicy(args.em, args.ctx, context)

  return finalizeGate(
    args.executorId,
    now,
    [business, capability, credential, authorization.check, policy],
    authorization.grantId,
  )
}
