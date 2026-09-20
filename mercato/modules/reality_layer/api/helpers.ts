import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'

export async function buildRealityRequestContext(req: Request): Promise<CommandRuntimeContext> {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.sub) throw new Error('Unauthorized')
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const organizationId = scope?.selectedId ?? auth.orgId ?? null
  if (!organizationId) throw new Error('Organization context required')
  return {
    container,
    auth,
    organizationScope: scope,
    selectedOrganizationId: organizationId,
    organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
    request: req,
  }
}

export async function runRealityMutation(
  req: Request,
  ctx: CommandRuntimeContext,
  commandId: string,
  input: Record<string, unknown>,
  resourceKind: string,
  resourceId: string | null,
  operation: 'create' | 'update',
): Promise<unknown> {
  const tenantId = ctx.auth?.tenantId ?? ''
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const userId = ctx.auth?.sub ?? ''
  const guard = await runRouteMutationGuards({
    container: ctx.container,
    req,
    auth: { userId, tenantId, organizationId },
    input: {
      resourceKind,
      resourceId,
      operation,
      mutationPayload: input,
    },
  })
  if (!guard.ok) return guard.response

  // Custom write routes must honor mutation-guard payload transforms exactly like
  // makeCrudRoute does. Registry guards may sanitize, constrain or enrich the
  // submitted payload; executing the original input would silently bypass that
  // contract while still reporting the guard as passed.
  const guardedInput = guard.modifiedPayload
    ? { ...input, ...guard.modifiedPayload }
    : input

  const commandBus = ctx.container.resolve('commandBus') as CommandBus
  const { result } = await commandBus.execute(commandId, { input: guardedInput, ctx })
  await guard.runAfterSuccess().catch(() => undefined)
  return result
}

export function scopedInput(ctx: CommandRuntimeContext, body: Record<string, unknown>) {
  return {
    ...body,
    tenantId: ctx.auth?.tenantId,
    organizationId: ctx.selectedOrganizationId ?? ctx.auth?.orgId,
  }
}
