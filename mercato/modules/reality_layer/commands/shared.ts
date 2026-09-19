import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

export type RealityScope = Readonly<{
  tenantId: string
  organizationId: string
}>

export function assertRealityScope(scope: RealityScope, ctx: CommandRuntimeContext): void {
  const authTenant = ctx.auth?.tenantId ?? null
  if (authTenant && authTenant !== scope.tenantId) {
    throw new Error('Cross-tenant Reality Layer mutation rejected.')
  }

  const activeOrganization = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (activeOrganization && activeOrganization !== scope.organizationId) {
    throw new Error('Cross-organization Reality Layer mutation rejected.')
  }

  if (!ctx.systemActor && (!authTenant || !activeOrganization)) {
    throw new Error('Reality Layer mutation requires tenant and organization scope.')
  }
}

export function resolveRealityEm(ctx: CommandRuntimeContext): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}
