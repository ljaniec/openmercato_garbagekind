import type { EntityManager } from '@mikro-orm/postgresql'
import { EvidenceEnvelope } from '../data/entities'
import type { EvidenceInput } from './executors/types'

export async function recordEvidence(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string; intentId: string; executionId: string },
  inputs: readonly EvidenceInput[],
): Promise<EvidenceEnvelope[]> {
  const recorded: EvidenceEnvelope[] = []
  for (const input of inputs.slice(0, 16)) {
    const existing = await em.findOne(EvidenceEnvelope, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      externalEventId: input.externalEventId,
    } as never)
    if (existing) {
      recorded.push(existing)
      continue
    }

    const row = em.create(EvidenceEnvelope, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      intentId: scope.intentId,
      executionId: scope.executionId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      evidenceType: input.evidenceType,
      claimJson: { ...input.claim },
      confidence: input.confidence ?? null,
      observedAt: new Date(input.observedAt),
      artifactRefs: [],
      provenanceJson: input.provenance ? { ...input.provenance } : null,
      externalEventId: input.externalEventId,
      lateEvent: false,
    } as never)
    em.persist(row)
    recorded.push(row)
  }
  await em.flush()
  return recorded
}
