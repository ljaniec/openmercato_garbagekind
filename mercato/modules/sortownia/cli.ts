import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TenantScope } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { InventoryBalance, WarehouseLocation } from '@open-mercato/core/modules/wms/data/entities'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { LegacyRpcClient, RPC_OK } from './lib/legacyRpc'
import { resolveCredentials } from './lib/adapter'
import {
  fileExists,
  fractionsFile,
  customersFile,
  ordersFile,
  movementsFile,
  readFractions,
  readCustomers,
  readOrders,
  readMovements,
  type LegacyMovementRow,
} from './lib/legacyFiles'
import { ensureCustomers } from './lib/customers'
import { ensureFractions, loadFractionIndex } from './lib/fractions'
import { applySalesOrders } from './lib/salesOrders'
import { applyMovementBatch, type MovementContext } from './lib/movements'
import { ensureTopology, loadLocationIndex } from './lib/topology'

/**
 * Komendy operatorskie modułu sortowni.
 *
 * Panel Data Sync zostaje właściwą drogą do uruchamiania synchronizacji; te
 * komendy służą do pierwszego zasiania środowiska i do diagnozy, gdy trzeba
 * zobaczyć wynik mapowania bez klikania.
 */

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]
    if (!part?.startsWith('--')) continue
    const [key, value] = part.slice(2).split('=')
    if (value !== undefined) {
      args[key] = value
    } else if (rest[index + 1] && !rest[index + 1]!.startsWith('--')) {
      args[key] = rest[index + 1]!
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

async function resolveScope(em: EntityManager, args: Record<string, string | boolean>): Promise<TenantScope> {
  const tenantId = typeof args.tenant === 'string' ? args.tenant : String(args.tenantId ?? '')
  const organizationId = typeof args.org === 'string' ? args.org : String(args.organizationId ?? '')
  if (tenantId && organizationId) return { tenantId, organizationId }

  // Środowisko demo ma jeden tenant i jedną organizację — nie każmy operatora
  // przepisywać UUID-ów z bazy.
  const rows = await em.getConnection().execute<Array<{ tenant_id: string; id: string }>>(
    'select tenant_id, id from organizations where deleted_at is null order by created_at asc limit 1',
  )
  if (!rows?.length) throw new Error('Brak organizacji — uruchom najpierw inicjalizację aplikacji.')
  return { tenantId: rows[0].tenant_id, organizationId: rows[0].id }
}

function buildCommandContext(container: Awaited<ReturnType<typeof createRequestContainer>>, scope: TenantScope): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  } as CommandRuntimeContext
}

const importCommand: ModuleCli = {
  command: 'import',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const scope = await resolveScope(em, args)
    const limit = Number.parseInt(String(args.limit ?? '0'), 10) || 0

    console.log(`Sortownia: import do organizacji ${scope.organizationId} (tenant ${scope.tenantId})`)

    // 1. Topologia — kanał XML-RPC.
    const credentials = resolveCredentials(undefined)
    const client = new LegacyRpcClient(credentials.endpoint)
    const code = await client.login(credentials.user, credentials.password, credentials.company)
    if (code !== RPC_OK) throw new Error(`System legacy odrzucił logowanie (kod ${code}).`)

    const list = await client.getLocationList()
    const detailed = []
    for (const location of list) {
      const details = await client.getLocationDetails(location.loccode)
      detailed.push({ ...location, ...(details ?? {}) })
    }
    const topology = await ensureTopology(em, scope, detailed)
    console.log(`  topologia: ${detailed.length} lokalizacji (nowych ${topology.created}, zaktualizowanych ${topology.updated})`)

    // 2. Frakcje — kanał plikowy.
    const fractionsPath = fractionsFile()
    if (!(await fileExists(fractionsPath))) throw new Error(`Brak katalogu frakcji: ${fractionsPath}`)
    const fractions = await readFractions(fractionsPath)
    const fractionResult = await ensureFractions(em, scope, fractions)
    console.log(`  frakcje: ${fractions.length} pozycji (nowych ${fractionResult.created})`)

    // 3. Kontrahenci — do modułu klientów, komendą CRM.
    const commandBus = container.resolve('commandBus') as CommandBus
    const commandContext = buildCommandContext(container, scope)
    const customersPath = customersFile()
    let customerIndex = new Map<string, string>()
    if (await fileExists(customersPath)) {
      const rows = await readCustomers(customersPath)
      const result = await ensureCustomers({ em, commandBus, commandContext, scope }, rows)
      customerIndex = result.index
      const created = result.outcomes.filter((o) => o.action === 'create').length
      const failedCustomers = result.outcomes.filter((o) => o.action === 'failed')
      console.log(`  kontrahenci: ${rows.length} pozycji (nowych ${created}, istniejących ${result.outcomes.length - created - failedCustomers.length})`)
      for (const outcome of failedCustomers) console.log(`    ! ${outcome.debtorno}: ${outcome.error}`)
    } else {
      console.log(`  kontrahenci: pominięto (brak ${customersPath})`)
    }

    // 4. Zamówienia sprzedaży i faktury — komendami modułu sprzedaży.
    const ordersPath = ordersFile()
    let salesOrderIndex = new Map<number, string>()
    if (await fileExists(ordersPath) && customerIndex.size > 0) {
      const rows = await readOrders(ordersPath)
      const result = await applySalesOrders(
        {
          em,
          commandBus,
          commandContext,
          scope,
          customers: customerIndex,
          fractions: await loadFractionIndex(em, scope),
          issueInvoices: args.faktury !== false && args['bez-faktur'] !== true,
        },
        rows,
      )
      salesOrderIndex = result.index
      const created = result.outcomes.filter((o) => o.action === 'create').length
      const invoiced = result.outcomes.filter((o) => o.invoiced).length
      const failedOrders = result.outcomes.filter((o) => o.action === 'failed')
      console.log(`  zamówienia: ${rows.length} pozycji (nowych ${created}, faktur ${invoiced}, istniejących ${result.outcomes.length - created - failedOrders.length})`)
      for (const outcome of failedOrders.slice(0, 10)) console.log(`    ! zamówienie ${outcome.orderno}: ${outcome.error}`)
    } else {
      console.log(`  zamówienia: pominięto (brak pliku albo kontrahentów)`)
    }

    // 5. Księga ruchów — kanał plikowy, zapis przez komendy WMS.
    const movementsPath = movementsFile()
    if (!(await fileExists(movementsPath))) throw new Error(`Brak księgi ruchów: ${movementsPath}`)

    const { warehouse, byCode } = await loadLocationIndex(em, scope)
    if (!warehouse) throw new Error('Magazyn nie powstał — przerwano.')

    const operator = await em.findOne(User, { tenantId: scope.tenantId }, { orderBy: { createdAt: 'asc' } })
    if (!operator) throw new Error('Brak użytkownika w tenancie.')

    const movementContext: MovementContext = {
      em,
      commandBus,
      commandContext,
      scope,
      warehouseId: warehouse.id,
      locations: byCode,
      fractions: await loadFractionIndex(em, scope),
      performedBy: operator.id,
      salesOrders: salesOrderIndex,
    }

    let buffer: LegacyMovementRow[] = []
    let carry: LegacyMovementRow[] = []
    let written = 0
    let duplicates = 0
    let failed = 0
    const errors: string[] = []

    const flush = async (final = false) => {
      if (!buffer.length && !final) return
      const result = await applyMovementBatch(movementContext, buffer, { carry, final })
      const outcomes = result.outcomes
      carry = result.carry
      buffer = []
      for (const outcome of outcomes) {
        if (outcome.action === 'create') written += 1
        else if (outcome.action === 'skip') duplicates += 1
        else {
          failed += 1
          if (errors.length < 5 && outcome.error) errors.push(`#${outcome.stkmoveno}: ${outcome.error}`)
        }
      }
    }

    let seen = 0
    for await (const row of readMovements(movementsPath)) {
      buffer.push(row)
      seen += 1
      if (buffer.length >= 100) await flush()
      if (limit && seen >= limit) break
    }
    await flush(true)

    console.log(`  ruchy: przeczytane ${seen}, zapisane ${written}, duplikaty ${duplicates}, błędy ${failed}`)
    for (const error of errors) console.log(`    ! ${error}`)

    const balances = await em.find(InventoryBalance, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })
    const locations = await em.find(WarehouseLocation, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })
    const codeById = new Map(locations.map((location) => [location.id, location.code]))
    const perLocation = new Map<string, number>()
    for (const balance of balances) {
      const locationId = (balance.location as unknown as { id: string })?.id
      const code = codeById.get(locationId) ?? '?'
      perLocation.set(code, (perLocation.get(code) ?? 0) + Number.parseFloat(balance.quantityOnHand))
    }
    console.log('  stany po imporcie:')
    for (const [code, quantity] of [...perLocation.entries()].sort()) {
      console.log(`    ${code.padEnd(8)} ${(quantity / 1000).toFixed(3).padStart(10)} Mg`)
    }
  },
}

export default [importCommand] satisfies ModuleCli[]
