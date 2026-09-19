import type {
  ExecutionStatus,
  PhysicalIntentStatus,
  RealityDiffStatus,
} from '../data/entities'

const intentTransitions: Readonly<Record<PhysicalIntentStatus, readonly PhysicalIntentStatus[]>> = {
  pending: ['blocked', 'authorized', 'cancelled'],
  blocked: ['authorized', 'cancelled'],
  authorized: ['dispatched', 'blocked', 'cancelled'],
  dispatched: ['executing', 'blocked', 'authorized'],
  executing: ['executed', 'failed'],
  executed: ['closed'],
  failed: ['closed'],
  cancelled: [],
  closed: [],
}

const executionTransitions: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  queued: ['started', 'abandoned', 'failed'],
  started: ['succeeded', 'failed', 'timed_out'],
  succeeded: [],
  failed: [],
  timed_out: [],
  abandoned: [],
}

const diffTransitions: Readonly<Record<RealityDiffStatus, readonly RealityDiffStatus[]>> = {
  proposed: ['needs_evidence', 'rejected', 'merging'],
  needs_evidence: ['proposed', 'rejected'],
  rejected: [],
  merging: ['merged', 'merge_failed'],
  merge_failed: ['merging', 'needs_evidence', 'rejected'],
  merged: [],
}

export function canTransitionIntent(
  from: PhysicalIntentStatus,
  to: PhysicalIntentStatus,
): boolean {
  return intentTransitions[from].includes(to)
}

export function assertIntentTransition(
  from: PhysicalIntentStatus,
  to: PhysicalIntentStatus,
): void {
  if (!canTransitionIntent(from, to)) {
    throw new Error('Illegal PhysicalIntent transition: ' + from + ' -> ' + to)
  }
}

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return executionTransitions[from].includes(to)
}

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransitionExecution(from, to)) {
    throw new Error('Illegal ExecutionRecord transition: ' + from + ' -> ' + to)
  }
}

export function canTransitionDiff(from: RealityDiffStatus, to: RealityDiffStatus): boolean {
  return diffTransitions[from].includes(to)
}

export function assertDiffTransition(from: RealityDiffStatus, to: RealityDiffStatus): void {
  if (!canTransitionDiff(from, to)) {
    throw new Error('Illegal RealityDiff transition: ' + from + ' -> ' + to)
  }
}
