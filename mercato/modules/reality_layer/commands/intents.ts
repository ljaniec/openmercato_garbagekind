import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { PhysicalIntent, type IntentOriginatorKind } from '../data/entities'
import {
  intentCancelSchema,
  physicalIntentCreateSchema,
  type IntentCancelInput,
  type PhysicalIntentCreateInput,
} from '../data/validators'
import { canonicalJson } from '../lib/canonical'
import { resolveRealityPrincipal } from '../lib/principal'
import { assertIntentTransition } from '../lib/stateMachine'
import { assertRealityScope, resolveRealityEm } from './shared'

function sameIntentRequest(
  existing: PhysicalIntent,
  input: PhysicalIntentCreateInput,
): boolean {
  return (
    existing.kind === input.kind &&
    existing.subjectKind === input.subjectKind &&
    existing.subjectId === input.subjectId &&
    (existing.sourceKind ?? null) === (input.sourceKind ?? null) &&
    (existing.sourceId ?? null) === (input.sourceId ?? null) &&
    existing.destinationKind === input.destinationKind &&
    existing.destinationId === input.destinationId &&
    (existing.contextKind ?? null) === (input.contextKind ?? null) &&
    (existing.contextId ?? null) === (input.contextId ?? null) &&
    canonicalJson(existing.parametersJson ?? {}) === canonicalJson(input.parameters ?? {})
  )
}

export const createPhysicalIntentCommand: CommandHandler<
  PhysicalIntentCreateInput,
  { intentId: string; status: string; idempotentReplay: boolean }
> = {
  id: 'reality_layer.intent.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = physicalIntentCreateSchema.parse(rawInput ?? {})
    assertRealityScope(input, ctx)

    const em = resolveRealityEm(ctx)
    const existing = await em.findOne(PhysicalIntent, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
    } as never)
    if (existing) {
      if (!sameIntentRequest(existing, input)) {
        throw new Error('PhysicalIntent idempotency key was already used for a different request.')
      }
      return { intentId: existing.id, status: existing.status, idempotentReplay: true }
    }

    const principal = await resolveRealityPrincipal(ctx, input.tenantId)
    const originatorKind: IntentOriginatorKind = principal.kind

    const intent = em.create(PhysicalIntent, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      kind: input.kind,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      sourceKind: input.sourceKind ?? null,
      sourceId: input.sourceId ?? null,
      destinationKind: input.destinationKind,
      destinationId: input.destinationId,
      contextKind: input.contextKind ?? null,
      contextId: input.contextId ?? null,
      parametersJson: input.parameters,
      status: 'pending',
      originatorUserId: principal.userId,
      originatorKind,
      originContextJson: input.originContext ?? null,
      selectedExecutorId: null,
      latestGateJson: null,
      idempotencyKey: input.idempotencyKey,
    } as never)

    em.persist(intent)
    await em.flush()
    return { intentId: intent.id, status: intent.status, idempotentReplay: false }
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Create physical intent',
    resourceKind: 'reality_layer.intent',
    resourceId: result.intentId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    payload: {
      kind: input.kind,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      destinationKind: input.destinationKind,
      destinationId: input.destinationId,
      idempotencyKey: input.idempotencyKey,
    },
    context: { idempotentReplay: result.idempotentReplay },
  }),
}

export const cancelPhysicalIntentCommand: CommandHandler<
  IntentCancelInput,
  { intentId: string; status: 'cancelled' }
> = {
  id: 'reality_layer.intent.cancel',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = intentCancelSchema.parse(rawInput ?? {})
    assertRealityScope(input, ctx)
    const em = resolveRealityEm(ctx)

    const intent = await em.findOne(PhysicalIntent, {
      id: input.intentId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    } as never)
    if (!intent) throw new Error('PhysicalIntent not found in the current scope.')

    assertIntentTransition(intent.status, 'cancelled')
    intent.status = 'cancelled'
    intent.latestGateJson = {
      kind: 'cancelled',
      reason: input.reason,
      at: new Date().toISOString(),
    }
    await em.flush()

    return { intentId: intent.id, status: 'cancelled' }
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Cancel physical intent',
    resourceKind: 'reality_layer.intent',
    resourceId: result.intentId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    payload: { reason: input.reason },
  }),
}

registerCommand(createPhysicalIntentCommand)
registerCommand(cancelPhysicalIntentCommand)
