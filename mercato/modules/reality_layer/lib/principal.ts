import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

export type RealityPrincipalKind = 'human' | 'agent' | 'service'

export type RealityPrincipal = Readonly<{
  userId: string
  kind: RealityPrincipalKind
}>

/**
 * Resolve the command actor through Open Mercato's query boundary.
 *
 * Deliberately uses the stable entity id literal instead of importing auth's
 * MikroORM entity or an app-generated alias. This keeps the same module
 * boundary used throughout physical_ai: other modules are addressed by IDs,
 * commands and services, never by sharing ORM metadata.
 */
export async function resolveRealityPrincipal(
  ctx: CommandRuntimeContext,
  tenantId: string,
): Promise<RealityPrincipal> {
  if (ctx.runAs?.actorUserId) {
    return { userId: ctx.runAs.actorUserId, kind: 'agent' }
  }

  const userId = ctx.auth?.sub ? String(ctx.auth.sub) : ''
  if (!userId) throw new Error('Reality Layer requires an authenticated principal.')

  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  const result = await queryEngine.query<{ id: string; kind?: string | null }>('auth:user', {
    tenantId,
    fields: ['id', 'kind'],
    filters: { id: userId },
    page: { page: 1, pageSize: 1 },
  })
  const row = result.items[0]
  if (!row) throw new Error('Authenticated principal could not be resolved in this tenant.')

  const kind = row.kind ?? 'human'
  if (kind !== 'human' && kind !== 'agent' && kind !== 'service') {
    throw new Error('Unsupported authenticated principal kind: ' + String(kind))
  }
  return { userId, kind }
}
