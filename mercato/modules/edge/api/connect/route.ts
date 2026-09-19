import type { EntityManager } from '@mikro-orm/postgresql'
import { runAgentCommand } from '../agentRoute'

/**
 * Ponowne połączenie agenta po restarcie albo po zerwaniu łącza.
 *
 * Otwiera nową sesję i wypiera poprzednią. Agent nie wraca do starej sesji
 * celowo: licznik kolejny zaczyna po restarcie od nowa, a sesja jest
 * jednostką, w której ten licznik ma sens.
 */
export const metadata = {
  requireAuth: false,
}

export async function POST(req: Request): Promise<Response> {
  return runAgentCommand(
    req,
    'edge.agents.connect',
    async (em: EntityManager, payload) => {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : null
      if (!agentId) return null
      const rows = await em.getConnection().execute<Array<{ organization_id: string }>>(
        'select organization_id from edge_agents where id = ? limit 1',
        [agentId],
      )
      return rows?.length ? { organizationId: rows[0].organization_id } : null
    },
    (payload) => ({
      agentId: payload.agentId,
      timestamp: payload.timestamp,
      signature: payload.signature,
      agentVersion: payload.agentVersion,
    }),
  )
}
