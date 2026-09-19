import {
  canTransitionDiff,
  canTransitionExecution,
  canTransitionIntent,
  assertIntentTransition,
} from '../lib/stateMachine'

describe('Reality Layer state machines', () => {
  it('permits the intended PhysicalIntent happy path', () => {
    expect(canTransitionIntent('pending', 'blocked')).toBe(true)
    expect(canTransitionIntent('blocked', 'authorized')).toBe(true)
    expect(canTransitionIntent('authorized', 'dispatched')).toBe(true)
    expect(canTransitionIntent('dispatched', 'executing')).toBe(true)
    expect(canTransitionIntent('executing', 'executed')).toBe(true)
    expect(canTransitionIntent('executed', 'closed')).toBe(true)
  })

  it('does not treat successful execution as a business reconciliation transition', () => {
    expect(canTransitionIntent('executing', 'closed')).toBe(false)
    expect(canTransitionDiff('proposed', 'merged')).toBe(false)
    expect(canTransitionDiff('proposed', 'merging')).toBe(true)
    expect(canTransitionDiff('merging', 'merged')).toBe(true)
  })

  it('keeps execution terminal states monotone', () => {
    expect(canTransitionExecution('started', 'succeeded')).toBe(true)
    expect(canTransitionExecution('succeeded', 'started')).toBe(false)
    expect(canTransitionExecution('timed_out', 'succeeded')).toBe(false)
    expect(canTransitionExecution('abandoned', 'started')).toBe(false)
  })

  it('rejects cancelling an intent after physical execution has started', () => {
    expect(() => assertIntentTransition('executing', 'cancelled')).toThrow(
      /Illegal PhysicalIntent transition/,
    )
  })
})
