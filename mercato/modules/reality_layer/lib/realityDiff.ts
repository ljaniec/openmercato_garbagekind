import type { EntityManager } from '@mikro-orm/postgresql'
import { EvidenceEnvelope, PhysicalIntent, RealityDiff } from '../data/entities'
import { sha256Canonical } from './canonical'

function asPositiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function claimLocation(evidence: EvidenceEnvelope): { kind: string; id: string } | null {
  const location = evidence.claimJson?.location
  if (!location || typeof location !== 'object' || Array.isArray(location)) return null
  const kind = (location as Record<string, unknown>).kind
  const id = (location as Record<string, unknown>).id
  return typeof kind === 'string' && typeof id === 'string' ? { kind, id } : null
}

export async function loadBusinessSnapshot(
  em: EntityManager,
  intent: PhysicalIntent,
): Promise<Record<string, unknown>> {
  const base = {
    subject: { kind: intent.subjectKind, id: intent.subjectId },
    source: { kind: intent.sourceKind, id: intent.sourceId },
    destination: { kind: intent.destinationKind, id: intent.destinationId },
    quantity: intent.parametersJson?.quantity ?? null,
  }

  if (
    intent.subjectKind !== 'catalog_variant' ||
    intent.sourceKind !== 'wms_location' ||
    intent.destinationKind !== 'wms_location'
  ) return base

  try {
    const rows = await em.getConnection().execute<Array<{ available: string | number | null }>>(
      'select coalesce(sum(coalesce(quantity_on_hand, 0) - coalesce(quantity_reserved, 0) - coalesce(quantity_allocated, 0)), 0) as available from wms_inventory_balances where tenant_id = ? and organization_id = ? and location_id = ? and catalog_variant_id = ? and deleted_at is null',
      [intent.tenantId, intent.organizationId, intent.sourceId, intent.subjectId],
    )
    return { ...base, availableAtSource: Number(rows?.[0]?.available ?? 0) }
  } catch {
    return { ...base, wmsSnapshotUnavailable: true }
  }
}

export async function buildRealityDiff(
  em: EntityManager,
  intent: PhysicalIntent,
  executionId: string,
  evidence: readonly EvidenceEnvelope[],
): Promise<RealityDiff | null> {
  const existing = await em.findOne(RealityDiff, {
    tenantId: intent.tenantId,
    organizationId: intent.organizationId,
    executionId,
  } as never)
  if (existing) return existing

  const locationEvidence = [...evidence]
    .reverse()
    .map((item) => ({ item, location: claimLocation(item) }))
    .find((entry) => entry.location !== null)
  if (!locationEvidence?.location) return null

  const businessBeforeJson = await loadBusinessSnapshot(em, intent)
  const observedLocation = locationEvidence.location
  const matchesIntent =
    observedLocation.kind === intent.destinationKind && observedLocation.id === intent.destinationId

  const quantity = asPositiveNumber(intent.parametersJson?.quantity)
  const warehouseId =
    typeof intent.parametersJson?.warehouseId === 'string'
      ? intent.parametersJson.warehouseId
      : null
  const wmsEligible =
    matchesIntent &&
    intent.subjectKind === 'catalog_variant' &&
    intent.sourceKind === 'wms_location' &&
    intent.destinationKind === 'wms_location' &&
    quantity !== null &&
    warehouseId !== null

  const effectInputJson: Record<string, unknown> = wmsEligible
    ? {
        warehouseId,
        fromLocationId: intent.sourceId,
        toLocationId: intent.destinationId,
        catalogVariantId: intent.subjectId,
        quantity,
        lotId:
          typeof intent.parametersJson?.lotId === 'string' ? intent.parametersJson.lotId : undefined,
        serialNumber:
          typeof intent.parametersJson?.serialNumber === 'string'
            ? intent.parametersJson.serialNumber
            : undefined,
      }
    : {}

  const diff = em.create(RealityDiff, {
    tenantId: intent.tenantId,
    organizationId: intent.organizationId,
    intentId: intent.id,
    executionId,
    status: 'proposed',
    businessBeforeJson,
    businessVersionDigest: sha256Canonical(businessBeforeJson),
    observedJson: {
      location: observedLocation,
      evidenceId: locationEvidence.item.id,
      matchesIntent,
    },
    proposedChangeJson: matchesIntent
      ? { move: { from: intent.sourceId, to: intent.destinationId, quantity } }
      : { manualReview: true, observedLocation },
    evidenceIds: evidence.map((item) => item.id).slice(0, 16),
    effectAdapterKey: wmsEligible ? 'wms_move' : 'manual_review',
    effectCommandId: wmsEligible ? 'wms.inventory.move' : '',
    effectInputJson,
    decisionActorUserId: null,
    decidedAt: null,
    mergeResultJson: null,
    failureCode: null,
  } as never)
  em.persist(diff)
  await em.flush()
  return diff
}
