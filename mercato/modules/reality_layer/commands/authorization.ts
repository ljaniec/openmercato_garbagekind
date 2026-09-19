import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { AuthorizationGrant, PhysicalIntent } from '../data/entities'
import {
  authorizationGrantSchema,
  type AuthorizationGrantInput,
} from '../data/validators'
import { sha256Canonical } from '../lib/canonical'
import { resolveRealityPrincipal } from '../lib/principal'
import { assertRealityScope, resolveRealityEm } from './shared'

function grantScopeDigest(intent: PhysicalIntent, executorId: string): string {
  return sha256Canonical({
    intentId: intent.id,
    kind: intent.kind,
    subject: { kind: intent.subjectKind, id: intent.subjectId },
    source:
      intent.sourceKind && intent.sourceId
        ? { kind: intent.sourceKind, id: intent.sourceId }
        : null,
    destination: { kind: intent.destinationKind, id: intent.destinationId },
    context:
      intent.contextKind && intent.contextId
        ? { kind: intent.contextKind, id: intent.contextId }
        : null,
    parameters: intent.parametersJson ?? {},
    executorId,
  })
}

function sameGrant(
  grant: AuthorizationGrant,
  input: AuthorizationGrantInput,
  digest: string,
  actorUserId: string,
): boolean {
  return (
    grant.intentId === input.intentId &&
    grant.executorId === input.executorId &&
    grant.grantedByUserId === actorUserId &&
    grant.scopeDigest === digest &&
    grant.expiresAt.getTime() === input.expiresAt.getTime()
  )
}

export const grantPhysicalAuthorizationCommand: CommandHandler<
  AuthorizationGrantInput,
  { grantId: string; scopeDigest: string; idempotentReplay: boolean }
> = {
  id: 'reality_layer.authorization.grant',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = authorizationGrantSchema.parse(rawInput ?? {})
    assertRealityScope(input, ctx)

    if (input.expiresAt.getTime() <= Date.now()) {
      throw new Error('Authorization grant expiry must be in the future.')
    }

    const principal = await resolveRealityPrincipal(ctx, input.tenantId)
    if (principal.kind !== 'human') {
      throw new Error('Only a human principal may grant physical authorization.')
    }

    const em = resolveRealityEm(ctx)
    const intent = await em.findOne(PhysicalIntent, {
      id: input.intentId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    } as never)
    if (!intent) throw new Error('PhysicalIntent not found in the current scope.')

    if (['dispatched', 'executing', 'executed', 'failed', 'cancelled', 'closed'].includes(intent.status)) {
      throw new Error('PhysicalIntent is no longer grantable in status ' + intent.status + '.')
    }

    if (intent.originatorUserId && intent.originatorUserId === principal.userId) {
      throw new Error('PhysicalIntent originator may not grant their own physical authorization.')
    }

    const scopeDigest = grantScopeDigest(intent, input.executorId)
    const existing = await em.findOne(AuthorizationGrant, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
    } as never)

    if (existing) {
      if (!sameGrant(existing, input, scopeDigest, principal.userId)) {
        throw new Error('AuthorizationGrant idempotency key was already used for a different grant.')
      }
      return { grantId: existing.id, scopeDigest, idempotentReplay: true }
    }

    const grant = em.create(AuthorizationGrant, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      intentId: intent.id,
      executorId: input.executorId,
      actionKind: intent.kind,
      destinationKind: intent.destinationKind,
      destinationId: intent.destinationId,
      grantedByUserId: principal.userId,
      scopeDigest,
      expiresAt: input.expiresAt,
      revokedAt: null,
      idempotencyKey: input.idempotencyKey,
    } as never)

    em.persist(grant)
    await em.flush()

    return { grantId: grant.id, scopeDigest, idempotentReplay: false }
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Grant physical authorization',
    resourceKind: 'reality_layer.authorization_grant',
    resourceId: result.grantId,
    relatedResourceKind: 'reality_layer.intent',
    relatedResourceId: input.intentId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    payload: {
      intentId: input.intentId,
      executorId: input.executorId,
      expiresAt: input.expiresAt,
      scopeDigest: result.scopeDigest,
      idempotencyKey: input.idempotencyKey,
    },
    context: { idempotentReplay: result.idempotentReplay },
  }),
}

export { grantScopeDigest }

registerCommand(grantPhysicalAuthorizationCommand)
