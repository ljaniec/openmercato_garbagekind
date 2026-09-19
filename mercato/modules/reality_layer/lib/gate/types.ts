import type { PhysicalIntent } from '../../data/entities'

export type GateCheckName =
  | 'business_precondition'
  | 'executor_capability'
  | 'executor_credential'
  | 'authorization_grant'
  | 'deterministic_policy'

export type GateCheckState = 'pass' | 'block' | 'unknown'

export type GateCheck = Readonly<{
  name: GateCheckName
  state: GateCheckState
  code: string
  reason: string
  details?: Record<string, unknown>
}>

export type GateDecision = 'authorized' | 'blocked'

export type GateEvaluation = Readonly<{
  schemaVersion: 1
  decision: GateDecision
  evaluatedAt: string
  executorId: string
  checks: readonly GateCheck[]
  grantId: string | null
}>

export type GateContext = Readonly<{
  intent: PhysicalIntent
  executorId: string
  now: Date
}>

export function gateCheck(
  name: GateCheckName,
  state: GateCheckState,
  code: string,
  reason: string,
  details?: Record<string, unknown>,
): GateCheck {
  return details ? { name, state, code, reason, details } : { name, state, code, reason }
}

export function finalizeGate(
  executorId: string,
  evaluatedAt: Date,
  checks: readonly GateCheck[],
  grantId: string | null,
): GateEvaluation {
  return {
    schemaVersion: 1,
    decision: checks.every((check) => check.state === 'pass') ? 'authorized' : 'blocked',
    evaluatedAt: evaluatedAt.toISOString(),
    executorId,
    checks,
    grantId,
  }
}
