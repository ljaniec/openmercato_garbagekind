import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'

/**
 * Kanał plikowy systemu legacy.
 *
 * Powód istnienia: webERP nie wystawia przez XML-RPC ani katalogu frakcji, ani
 * księgi ruchów. W sortowni te dane przychodzą zrzutem — excelem z księgowości
 * albo nocnym eksportem. Moduł czyta je stąd, zamiast udawać, że API je oddaje.
 */

export type LegacyMovementRow = {
  stkmoveno: number
  stockid: string
  typ: 'PZ' | 'SORT' | 'WZ'
  loccode: string
  data: string
  debtorno: string
  iloscKg: number
  iloscMg: number
}

export type LegacyFractionRow = {
  stockid: string
  nazwa: string
  kategoria: string
  jednostka: string
  koszt: number
}

/** Rozdziela wiersz CSV z obsługą cudzysłowów — tyle, ile wymaga eksport legacy. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      out.push(field)
      field = ''
    } else {
      field += char
    }
  }
  out.push(field)
  return out
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Czyta CSV strumieniowo: księga ruchów bywa duża, a import ma być wznawialny. */
export async function* readCsvRows(filePath: string): AsyncGenerator<Record<string, string>> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let header: string[] | null = null
  try {
    for await (const rawLine of lines) {
      const line = rawLine.replace(/^﻿/, '')
      if (!line.trim()) continue
      const cells = splitCsvLine(line)
      if (!header) {
        header = cells.map((cell) => cell.trim())
        continue
      }
      const row: Record<string, string> = {}
      header.forEach((name, index) => {
        row[name] = (cells[index] ?? '').trim()
      })
      yield row
    }
  } finally {
    lines.close()
    stream.close()
  }
}

function toNumber(value: string | undefined): number {
  const parsed = Number.parseFloat((value ?? '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : 0
}

export function legacyOutDir(): string {
  return process.env.SORTOWNIA_LEGACY_OUT ?? path.resolve(process.cwd(), '../../out')
}

export function movementsFile(): string {
  return path.join(legacyOutDir(), 'ruchy.csv')
}

export function fractionsFile(): string {
  return path.join(legacyOutDir(), 'frakcje.csv')
}

export async function* readMovements(filePath: string): AsyncGenerator<LegacyMovementRow> {
  for await (const row of readCsvRows(filePath)) {
    const stkmoveno = Number.parseInt(row.stkmoveno ?? '', 10)
    if (!Number.isFinite(stkmoveno)) continue
    const typ = (row.typ ?? '').toUpperCase()
    if (typ !== 'PZ' && typ !== 'SORT' && typ !== 'WZ') continue
    yield {
      stkmoveno,
      stockid: row.stockid ?? '',
      typ,
      loccode: row.loccode ?? '',
      data: row.data ?? '',
      debtorno: row.debtorno ?? '',
      iloscKg: toNumber(row.ilosc_kg),
      iloscMg: toNumber(row.ilosc_mg),
    }
  }
}

export async function readFractions(filePath: string): Promise<LegacyFractionRow[]> {
  const out: LegacyFractionRow[] = []
  for await (const row of readCsvRows(filePath)) {
    if (!row.stockid) continue
    out.push({
      stockid: row.stockid,
      // Pusta komórka to nie brak kolumny: `??` przepuściłby '' i katalog
      // dostałby pozycję bez nazwy, a `title` produktu jest wymagane.
      nazwa: row.nazwa?.trim() ? row.nazwa.trim() : row.stockid,
      kategoria: row.kategoria ?? '',
      jednostka: row.jednostka ?? 'kg',
      koszt: toNumber(row.koszt),
    })
  }
  return out
}

/**
 * Deterministyczny UUID z dowolnego klucza legacy.
 *
 * WMS wymaga `referenceId` w formacie UUID, a system legacy numeruje ruchy
 * liczbą (`stkmoveno`). Ten sam numer musi dawać ten sam UUID przy każdym
 * przebiegu — inaczej idempotencja WMS-u nie miałaby na czym się oprzeć
 * i ponowny import zdublowałby ruchy.
 */
export function legacyUuid(namespace: string, key: string | number): string {
  const digest = createHash('sha1').update(`sortownia:${namespace}:${key}`).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // wersja 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // wariant RFC 4122
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
