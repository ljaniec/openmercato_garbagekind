import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Wdrożenia etapowe dla pulpitu.
 *
 * Ekran ma odpowiedzieć na jedno pytanie: **dlaczego to wdrożenie stoi tam,
 * gdzie stoi**. Dlatego przy każdym etapie jedzie ostatni werdykt bramy razem
 * ze zmierzonymi wartościami, a nie sam status. Status bez liczb zmusza do
 * przeliczenia księgi wstecz, a księga w międzyczasie urosła.
 *
 * `getAuthFromRequest`, nie wariant ciastkowy.
 */

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['rollout.view'] },
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  const organizationId = await resolveActiveOrganizationId(auth)
  if (!organizationId) return json({ error: 'organization_scope_required' }, 400)

  const tenantId = auth.tenantId as string
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const rollouts = await em.getConnection().execute<Array<{
    id: string
    name: string
    mode: string
    status: string
    status_reason: string | null
    started_at: string | null
    finished_at: string | null
    policy_key: string
    policy_version: number
  }>>(
    `select r.id, r.name, r.mode, r.status, r.status_reason, r.started_at, r.finished_at,
            p.policy_key, v.version as policy_version
       from rollout_rollouts r
       join policy_registry_policy_versions v on v.id = r.policy_version_id
       join policy_registry_policies p on p.id = v.policy_id
      where r.tenant_id = ?
      order by r.created_at desc`,
    [tenantId],
  )

  const stages = await em.getConnection().execute<Array<{
    id: string
    rollout_id: string
    ordinal: number
    name: string
    status: string
    min_episodes: number
    max_intervention_rate: string
    max_severe_rate: string
    min_success_rate: string
    members: string
    rolled_back: string
    decision: string | null
    reason: string | null
    episodes: number | null
    intervention_rate: string | null
    severe_rate: string | null
    success_rate: string | null
    evaluated_at: string | null
    actor_user_id: string | null
  }>>(
    `select s.id, s.rollout_id, s.ordinal, s.name, s.status,
            s.min_episodes, s.max_intervention_rate, s.max_severe_rate, s.min_success_rate,
            (select count(*) from rollout_stage_members m where m.stage_id = s.id) as members,
            (select count(*) from rollout_stage_members m
              where m.stage_id = s.id and m.rolled_back_at is not null) as rolled_back,
            g.decision, g.reason, g.episodes, g.intervention_rate, g.severe_rate, g.success_rate,
            g.evaluated_at, g.actor_user_id
       from rollout_stages s
       left join lateral (
         select decision, reason, episodes, intervention_rate, severe_rate, success_rate,
                evaluated_at, actor_user_id
           from rollout_gate_evaluations
          where stage_id = s.id order by evaluated_at desc limit 1
       ) g on true
      where s.tenant_id = ?
      order by s.rollout_id, s.ordinal`,
    [tenantId],
  )

  const byRollout = new Map<string, unknown[]>()
  for (const stage of stages) {
    const list = byRollout.get(stage.rollout_id) ?? []
    list.push({
      id: stage.id,
      ordinal: Number(stage.ordinal),
      name: stage.name,
      status: stage.status,
      members: Number(stage.members),
      rolledBackMembers: Number(stage.rolled_back),
      thresholds: {
        minEpisodes: Number(stage.min_episodes),
        maxInterventionRate: Number(stage.max_intervention_rate),
        maxSevereRate: Number(stage.max_severe_rate),
        minSuccessRate: Number(stage.min_success_rate),
      },
      lastGate: stage.decision
        ? {
            decision: stage.decision,
            reason: stage.reason,
            episodes: Number(stage.episodes),
            interventionRate: Number(stage.intervention_rate),
            severeRate: Number(stage.severe_rate),
            successRate: Number(stage.success_rate),
            evaluatedAt: stage.evaluated_at ? new Date(stage.evaluated_at).toISOString() : null,
            // Pusty sprawca znaczy: automat. W poprawnie działającym wdrożeniu
            // ta wartość jest pusta przy każdym wpisie.
            automatic: stage.actor_user_id === null,
          }
        : null,
    })
    byRollout.set(stage.rollout_id, list)
  }

  const rows = rollouts.map((rollout) => ({
    id: rollout.id,
    name: rollout.name,
    mode: rollout.mode,
    status: rollout.status,
    statusReason: rollout.status_reason,
    policy: `${rollout.policy_key} v${rollout.policy_version}`,
    startedAt: rollout.started_at ? new Date(rollout.started_at).toISOString() : null,
    finishedAt: rollout.finished_at ? new Date(rollout.finished_at).toISOString() : null,
    /**
     * Ograniczenie trybu cieniowego jedzie w odpowiedzi jako tekst.
     *
     * Nie jest to ozdoba: to jedyne miejsce, w którym ktoś patrzący na zielony
     * etap cieniowy dowie się, że ten etap nie jest dowodem bezpieczeństwa.
     */
    shadowCaveat:
      rollout.mode === 'shadow'
        ? 'tryb cieniowy dowodzi wyłącznie zgodności predykcji; dla polityki zmieniającej stan świata nie zastępuje etapu czynnego'
        : null,
    stages: byRollout.get(rollout.id) ?? [],
  }))

  return json(
    {
      generatedAt: new Date().toISOString(),
      totals: {
        rollouts: rows.length,
        running: rows.filter((r) => r.status === 'running').length,
        rolledBack: rows.filter((r) => r.status === 'rolled_back').length,
        completed: rows.filter((r) => r.status === 'completed').length,
      },
      rollouts: rows,
    },
    200,
  )
}
