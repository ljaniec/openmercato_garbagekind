import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { E } from '#generated/entities.ids.generated'

export type RealityPrincipalKind = 'human' | 'agent' | 'service'

export type RealityPrincipal = Readonly<{
  userId: string
  kind: RealityPrincipalKind
}>

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
  const result = await queryEngine.query<{ id: string; kind?: string | null }>(E.auth.user, {
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
