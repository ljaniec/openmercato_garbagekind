import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import type { LegacyCustomerRow } from './legacyFiles'

/**
 * Kontrahenci systemu legacy jako firmy w module klientów Open Mercato.
 *
 * W starym systemie `debtorsmaster` to jedna płaska tabela: dostawca odpadu
 * i odbiorca frakcji różnią się wyłącznie literami w kolumnie `debtortype`.
 * Po stronie Mercato zostają firmami w CRM, więc dostają to, czego stary
 * system nie miał gdzie trzymać — historię kontaktów, właściciela opiekuna,
 * etykiety i powiązanie z dokumentami sprzedaży.
 *
 * Tworzymy je komendą `customers.companies.create`, a nie zapisem do encji,
 * bo komenda odpala zdarzenia, wpis do dziennika audytu i indeks wyszukiwania.
 * Zapis na skróty dałby wiersz w bazie, którego reszta platformy by nie widziała.
 */

export type CustomerContext = {
  em: EntityManager
  commandBus: CommandBus
  commandContext: CommandRuntimeContext
  scope: TenantScope
}

/** `debtorno` → identyfikator encji klienta, którym posługuje się sprzedaż. */
export type CustomerIndex = Map<string, string>

export type CustomerOutcome = {
  debtorno: string
  action: 'create' | 'update' | 'skip' | 'failed'
  error?: string
}

/** Rola kontrahenta czytelna dla człowieka — w legacy to trzy litery. */
export function describeRole(typ: string): string {
  if (typ === 'DOS') return 'Dostawca odpadu'
  if (typ === 'ODB') return 'Odbiorca frakcji'
  return 'Kontrahent'
}

/**
 * Znacznik pochodzenia rekordu wraz z kluczem ze starego systemu.
 *
 * Kontrakt firmy w Open Mercato nie ma pola na identyfikator zewnętrzny, a
 * dokładanie go własną migracją byłoby rozpychaniem cudzego schematu pod jeden
 * import. `source` znaczy dokładnie „skąd ten rekord pochodzi", więc
 * `sortownia-legacy:D005` jest użyciem zgodnym ze znaczeniem pola, a nie
 * obejściem — i przy okazji daje nam klucz idempotencji.
 */
export const LEGACY_SOURCE_PREFIX = 'sortownia-legacy'

export function legacySource(debtorno: string): string {
  return `${LEGACY_SOURCE_PREFIX}:${debtorno}`
}

export function debtornoFromSource(source: string | null | undefined): string | null {
  if (!source) return null
  const prefix = `${LEGACY_SOURCE_PREFIX}:`
  return source.startsWith(prefix) ? source.slice(prefix.length) : null
}

export async function loadCustomerIndex(
  em: EntityManager,
  scope: TenantScope,
): Promise<CustomerIndex> {
  const rows = await em.find(CustomerEntity, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    source: { $like: `${LEGACY_SOURCE_PREFIX}:%` },
  } as never)
  const index: CustomerIndex = new Map()
  for (const row of rows as Array<{ id: string; source?: string | null }>) {
    const debtorno = debtornoFromSource(row.source)
    if (debtorno) index.set(debtorno, row.id)
  }
  return index
}

export async function ensureCustomers(
  ctx: CustomerContext,
  rows: LegacyCustomerRow[],
): Promise<{ index: CustomerIndex; outcomes: CustomerOutcome[] }> {
  const index = await loadCustomerIndex(ctx.em, ctx.scope)
  const outcomes: CustomerOutcome[] = []

  for (const row of rows) {
    const debtorno = row.debtorno.trim()
    if (!debtorno) continue

    if (index.has(debtorno)) {
      outcomes.push({ debtorno, action: 'skip' })
      continue
    }

    try {
      const result = (await ctx.commandBus.execute(
        'customers.companies.create',
        {
          input: {
            organizationId: ctx.scope.organizationId,
            tenantId: ctx.scope.tenantId,
            displayName: row.nazwa,
            legalName: row.nazwa,
            // NIP nie ma własnej kolumny w kontrakcie firmy, a wymyślanie jej
            // przez pole niestandardowe kosztowałoby migrację. Numer jest
            // potrzebny na fakturze, więc jedzie w opisie razem z rolą — tak,
            // jak księgowa trzyma go dziś w nazwie folderu.
            description: [
              describeRole(row.typ),
              row.nip ? `NIP ${row.nip}` : null,
              `Kontrahent ${debtorno} z systemu legacy`,
              row.klientOd ? `współpraca od ${row.klientOd}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
            industry: 'Gospodarka odpadami',
            source: legacySource(debtorno),
            isActive: true,
          },
          ctx: ctx.commandContext,
        },
        // `commandBus.execute` zwraca kopertę `{ result, logEntry }`, a nie
        // samą wartość handlera — właściwy identyfikator siedzi o poziom głębiej.
      )) as { result?: { entityId?: string } } | undefined

      const entityId = result?.result?.entityId
      if (!entityId) {
        outcomes.push({ debtorno, action: 'failed', error: 'komenda nie zwróciła identyfikatora' })
        continue
      }
      index.set(debtorno, entityId)
      outcomes.push({ debtorno, action: 'create' })
    } catch (error) {
      outcomes.push({
        debtorno,
        action: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { index, outcomes }
}
