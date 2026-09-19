import { createReadStream } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'

export const integrationMeta = {
  dependsOnModules: ['sortownia', 'wms', 'catalog'],
}

/**
 * Cross-walidacja: czy Open Mercato mówi to samo, co system legacy.
 *
 * Obie strony liczą z tej samej księgi, ale zupełnie inaczej: legacy trzyma
 * płaskie wiersze `stockmoves` w kilogramach, Mercato prowadzi salda w WMS
 * i zwija parę `SORT` w jeden `transfer`. Jeżeli mapowanie gdzieś się
 * przekłamie — znak przy wydaniu, zgubiona para, jednostka — salda się
 * rozjadą i ten test to pokaże.
 *
 * Źródłem prawdy jest `out/ruchy.csv` (kanał plikowy legacy), a nie
 * `out/stany.csv`: stany są migawką z chwili eksportu, a księga opisuje
 * wszystko, co Mercato zdążyło zaimportować.
 */

const LEGACY_OUT = process.env.SORTOWNIA_LEGACY_OUT ?? '/home/user/openmercato_garbagekind/out'
const MOVEMENTS_CSV = path.join(LEGACY_OUT, 'ruchy.csv')
const ORDERS_CSV = path.join(LEGACY_OUT, 'zamowienia.csv')
const TOLERANCE_KG = 0.05

type LegacyRow = {
  stkmoveno: number
  stockid: string
  typ: 'PZ' | 'SORT' | 'WZ'
  loccode: string
  iloscKg: number
  iloscMg: number
}

type LegacyOrder = {
  orderno: number
  debtorno: string
  stockid: string
  iloscKg: number
  cenaKg: number
}

type DashboardPayload = {
  totals: { yardKg: number; binsKg: number; movements30d: number }
  locations: Array<{ code: string; type: string; quantityKg: number | null; capacityKg: number | null; utilisation: number | null }>
  fractions: Array<{ sku: string; quantityKg: number }>
  movements: Array<{ type: string; legacyMoveNo: number | string | null }>
  sales?: {
    orders: number
    invoices: number
    netPln: number
    grossPln: number
    topBuyers: Array<{ nazwa: string; netPln: number; orders: number }>
  }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      out.push(field)
      field = ''
    } else field += char
  }
  out.push(field)
  return out
}

async function readLegacyLedger(): Promise<LegacyRow[]> {
  const rows: LegacyRow[] = []
  const stream = createReadStream(MOVEMENTS_CSV, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let header: string[] | null = null
  for await (const rawLine of lines) {
    const line = rawLine.replace(/^﻿/, '')
    if (!line.trim()) continue
    const cells = splitCsvLine(line)
    if (!header) {
      header = cells.map((cell) => cell.trim())
      continue
    }
    const record: Record<string, string> = {}
    header.forEach((name, index) => {
      record[name] = (cells[index] ?? '').trim()
    })
    const stkmoveno = Number.parseInt(record.stkmoveno ?? '', 10)
    const typ = (record.typ ?? '').toUpperCase()
    if (!Number.isFinite(stkmoveno)) continue
    if (typ !== 'PZ' && typ !== 'SORT' && typ !== 'WZ') continue
    rows.push({
      stkmoveno,
      stockid: record.stockid ?? '',
      typ,
      loccode: (record.loccode ?? '').toUpperCase(),
      iloscKg: Number.parseFloat((record.ilosc_kg ?? '0').replace(',', '.')),
      iloscMg: Number.parseFloat((record.ilosc_mg ?? '0').replace(',', '.')),
    })
  }
  return rows
}

async function readLegacyOrders(): Promise<LegacyOrder[]> {
  const rows: LegacyOrder[] = []
  const stream = createReadStream(ORDERS_CSV, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let header: string[] | null = null
  for await (const rawLine of lines) {
    const line = rawLine.replace(/^﻿/, '')
    if (!line.trim()) continue
    const cells = splitCsvLine(line)
    if (!header) {
      header = cells.map((cell) => cell.trim())
      continue
    }
    const record: Record<string, string> = {}
    header.forEach((name, index) => {
      record[name] = (cells[index] ?? '').trim()
    })
    const orderno = Number.parseInt(record.orderno ?? '', 10)
    if (!Number.isFinite(orderno)) continue
    rows.push({
      orderno,
      debtorno: record.debtorno ?? '',
      stockid: record.stockid ?? '',
      iloscKg: Number.parseFloat((record.ilosc_kg ?? '0').replace(',', '.')),
      cenaKg: Number.parseFloat((record.cena_kg ?? '0').replace(',', '.')),
    })
  }
  return rows
}

/** Saldo liczone wprost z księgi legacy: suma ilości per lokalizacja i per frakcja. */
function ledgerBalances(rows: LegacyRow[]) {
  const perLocation = new Map<string, number>()
  const perFraction = new Map<string, number>()
  for (const row of rows) {
    perLocation.set(row.loccode, (perLocation.get(row.loccode) ?? 0) + row.iloscKg)
    perFraction.set(row.stockid, (perFraction.get(row.stockid) ?? 0) + row.iloscKg)
  }
  return { perLocation, perFraction }
}

/** Ile ruchów powinno powstać w WMS: para SORT zwija się w jeden `transfer`. */
function expectedMovementCount(rows: LegacyRow[]): number {
  const sortRows = rows.filter((row) => row.typ === 'SORT').length
  const rest = rows.length - sortRows
  return rest + sortRows / 2
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function loadDashboard(request: APIRequestContext): Promise<DashboardPayload> {
  // Pulpit ogląda brygadzista, więc sprawdzamy go kontem pracownika:
  // `setup.ts` nadaje roli `employee` uprawnienie `sortownia.view`.
  const token = await getAuthToken(request, 'employee')
  const response = await apiRequest(request, 'GET', '/api/sortownia/dashboard', { token })
  expect(response.status(), 'pulpit sortowni musi odpowiedzieć').toBe(200)
  return (await response.json()) as DashboardPayload
}

test.describe('TC-SORT-001 — zgodność Open Mercato z księgą systemu legacy', () => {
  test.beforeAll(async () => {
    const present = await fileExists(MOVEMENTS_CSV)
    test.skip(!present, `Brak zrzutu legacy: ${MOVEMENTS_CSV}. Uruchom eksport po stronie starego systemu.`)
  })

  test('stan każdej lokalizacji zgadza się z sumą ruchów w księdze legacy', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const { perLocation } = ledgerBalances(ledger)
    const dashboard = await loadDashboard(request)

    for (const location of dashboard.locations) {
      const expectedKg = perLocation.get(location.code.toUpperCase())
      if (expectedKg === undefined) continue
      expect
        .soft(location.quantityKg ?? 0, `lokalizacja ${location.code}`)
        .toBeCloseTo(expectedKg, 1)
    }

    // Żadna lokalizacja z księgi nie może zniknąć po drodze.
    const codes = new Set(dashboard.locations.map((row) => row.code.toUpperCase()))
    for (const code of perLocation.keys()) {
      expect(codes, `lokalizacja ${code} musi istnieć w Open Mercato`).toContain(code)
    }
  })

  test('stan każdej frakcji zgadza się z sumą ruchów w księdze legacy', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const { perFraction } = ledgerBalances(ledger)
    const dashboard = await loadDashboard(request)

    const bySku = new Map(dashboard.fractions.map((row) => [row.sku, row.quantityKg]))
    for (const [stockid, expectedKg] of perFraction) {
      const actual = bySku.get(stockid)
      expect(actual, `frakcja ${stockid} musi być w katalogu`).toBeDefined()
      expect.soft(actual ?? 0, `frakcja ${stockid}`).toBeCloseTo(expectedKg, 1)
    }
  })

  test('para SORT zwija się w jeden ruch — liczba ruchów musi się zgadzać', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const dashboard = await loadDashboard(request)
    expect(dashboard.totals.movements30d).toBe(expectedMovementCount(ledger))
  })

  test('suma na placu i w boksach odtwarza podział z systemu legacy', async ({ request }) => {
    const ledger = await readLegacyLedger()
    const { perLocation } = ledgerBalances(ledger)
    const dashboard = await loadDashboard(request)

    const yardKg = perLocation.get('PRZYJ') ?? 0
    const binsKg = [...perLocation.entries()]
      .filter(([code]) => code !== 'PRZYJ')
      .reduce((sum, [, value]) => sum + value, 0)

    expect(dashboard.totals.yardKg).toBeCloseTo(yardKg, 1)
    expect(dashboard.totals.binsKg).toBeCloseTo(binsKg, 1)
  })

  test('żaden stan nie schodzi poniżej zera — magazyn nie wydaje więcej, niż przyjął', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    for (const location of dashboard.locations) {
      expect.soft(location.quantityKg ?? 0, `lokalizacja ${location.code}`).toBeGreaterThanOrEqual(-TOLERANCE_KG)
    }
    for (const fraction of dashboard.fractions) {
      expect.soft(fraction.quantityKg, `frakcja ${fraction.sku}`).toBeGreaterThanOrEqual(-TOLERANCE_KG)
    }
  })

  test('zapełnienie liczone jest względem pojemności, a nie zmyślane', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    for (const location of dashboard.locations) {
      if (location.capacityKg === null) {
        expect(location.utilisation, `lokalizacja ${location.code} bez pojemności`).toBeNull()
        continue
      }
      const expected = ((location.quantityKg ?? 0) / location.capacityKg) * 100
      expect.soft(location.utilisation ?? 0, `lokalizacja ${location.code}`).toBeCloseTo(expected, 0)
    }
  })

  test('każdy ruch na pulpicie niesie numer z systemu legacy', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    expect(dashboard.movements.length).toBeGreaterThan(0)

    for (const movement of dashboard.movements) {
      expect(movement.legacyMoveNo, `ruch ${movement.type} bez śladu w legacy`).not.toBeNull()
    }

    // Przesunięcie pochodzi z pary wierszy, więc musi wskazywać oba numery.
    const transfer = dashboard.movements.find((movement) => movement.type === 'transfer')
    if (transfer) {
      expect(String(transfer.legacyMoveNo)).toMatch(/^\d+ \+ \d+$/)
    }
  })

  test('każde wydanie ze starego systemu ma swoje zamówienie sprzedaży', async ({ request }) => {
    const orders = await readLegacyOrders()
    const dashboard = await loadDashboard(request)
    expect(dashboard.sales, 'pulpit musi raportować sprzedaż').toBeDefined()
    expect(dashboard.sales?.orders).toBe(orders.length)
  })

  test('każde zamówienie jest zafakturowane — faktura bez zamówienia jest bezwartościowa', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    expect(dashboard.sales?.invoices).toBe(dashboard.sales?.orders)
  })

  test('przychód zgadza się z cennikiem starego systemu co do grosza', async ({ request }) => {
    const orders = await readLegacyOrders()
    const dashboard = await loadDashboard(request)
    // Każdy wiersz legacy to ilość w kilogramach razy cena za kilogram.
    // Gdyby cena trafiła do dokumentu jako cena za całe wydanie albo ilość
    // poszła w tonach, ta suma rozjechałaby się o rzędy wielkości.
    const expectedNet = orders.reduce((sum, row) => sum + row.iloscKg * row.cenaKg, 0)
    expect(dashboard.sales?.netPln ?? 0).toBeCloseTo(expectedNet, 1)
  })

  test('kwota brutto to netto powiększone o stawkę VAT, a nie liczba wzięta znikąd', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const net = dashboard.sales?.netPln ?? 0
    const gross = dashboard.sales?.grossPln ?? 0
    expect(gross).toBeCloseTo(net * 1.23, 0)
  })

  test('nazwy odbiorców są czytelne, a nie kryptogramem z bazy', async ({ request }) => {
    const dashboard = await loadDashboard(request)
    const buyers = dashboard.sales?.topBuyers ?? []
    expect(buyers.length).toBeGreaterThan(0)
    for (const buyer of buyers) {
      // Pola tekstowe kontrahenta są szyfrowane w spoczynku. Odczyt surowym
      // SQL-em oddaje ciąg w rodzaju `BZhh3D8l...:v1` i ląduje on na ekranie.
      expect.soft(buyer.nazwa, 'nazwa odbiorcy wygląda na kryptogram').not.toMatch(/:v\d+$/)
      expect.soft(buyer.nazwa.length, `nazwa odbiorcy: ${buyer.nazwa}`).toBeLessThan(80)
    }
  })

  test('konwersja kilogramów na megagramy jest spójna w całej księdze legacy', async () => {
    const ledger = await readLegacyLedger()
    const rozjazdy = ledger.filter((row) => Math.abs(row.iloscKg / 1000 - row.iloscMg) > 0.001)
    expect(rozjazdy.map((row) => row.stkmoveno)).toEqual([])
  })
})
