/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import SortowniaDashboard from '../SortowniaDashboard'

/**
 * Pulpit ogląda brygadzista, nie programista. Sprawdzamy to, co widzi:
 * masy w megagramach, ostrzeżenie o zapełnieniu, kierunek ruchu po ludzku
 * i numer z systemu legacy, po którym wraca się do kwitu wagowego.
 */

const apiFetchMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

// Wykresy mają własne testy w pakiecie ui; tutaj interesuje nas treść pulpitu.
jest.mock('@open-mercato/ui/backend/charts', () => ({
  KpiCard: ({ title, value, suffix, footer }: { title: string; value: number | null; suffix?: string; footer?: React.ReactNode }) => (
    <div data-testid="kpi">
      <span>{title}</span>
      <strong>{value === null ? '—' : `${value}${suffix ?? ''}`}</strong>
      <div>{footer}</div>
    </div>
  ),
  BarChart: ({ title, data }: { title: string; data: Array<Record<string, unknown>> }) => (
    <div data-testid="chart" data-rows={data.length}>
      {title}
    </div>
  ),
}))

const payload = {
  generatedAt: '2026-09-19T00:16:00.000Z',
  totals: {
    yardKg: 117664.5,
    binsKg: 102813.24,
    receipts30dKg: 385384,
    issues30dKg: 164910,
    sorted30dKg: 235890,
    movements30d: 176,
    lastMovementAt: '2026-09-18T22:14:50.000Z',
  },
  locations: [
    { code: 'PRZYJ', type: 'staging', capacityKg: 150000, quantityKg: 117664.5, utilisation: 78.4, legacyName: 'Plac przyjec' },
    { code: 'BOKS1', type: 'bin', capacityKg: 60000, quantityKg: 4685.98, utilisation: 7.8, legacyName: 'Boks 1 - papier' },
  ],
  fractions: [
    { sku: '20 01 01', name: 'Papier i tektura', quantityKg: 4000, reorderPointKg: 8000, belowReorderPoint: true },
    { sku: '20 01 02', name: 'Szklo opakowaniowe', quantityKg: 77218, reorderPointKg: 10000, belowReorderPoint: false },
  ],
  flow: [{ sku: '20 01 01', receivedKg: 63000, sortedKg: 50300, issuedKg: 45700 }],
  movements: [
    {
      id: 'm1',
      type: 'transfer',
      performedAt: '2026-09-18T22:14:44.000Z',
      quantityKg: 4685.98,
      fractionSku: '20 01 01',
      fractionName: 'Papier i tektura',
      fromCode: 'PRZYJ',
      toCode: 'BOKS1',
      reason: 'Wysortowanie frakcji',
      legacyMoveNo: '100240 + 100241',
    },
    {
      id: 'm2',
      type: 'adjust',
      performedAt: '2026-09-18T07:44:00.000Z',
      quantityKg: -4548,
      fractionSku: '20 01 01',
      fractionName: 'Papier i tektura',
      fromCode: null,
      toCode: 'BOKS1',
      reason: 'Wydanie do odbiorcy D005',
      legacyMoveNo: 100237,
    },
  ],
}

function respondWith(body: unknown, ok = true, status = 200) {
  apiFetchMock.mockResolvedValue({
    ok,
    status,
    json: async () => body,
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  respondWith(payload)
})

describe('SortowniaDashboard', () => {
  it('pobiera dane z punktu końcowego pulpitu', async () => {
    render(<SortowniaDashboard />)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/sortownia/dashboard'))
  })

  it('pokazuje masy w megagramach, bo w takich jednostkach rozlicza się odpady', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Na placu przyjęć')
    expect(screen.getByText('117.665 Mg')).toBeInTheDocument()
  })

  it('pokazuje zapełnienie lokalizacji obok jej pojemności', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('PRZYJ')
    expect(screen.getByText('78.4%')).toBeInTheDocument()
    // 150 000 kg pojemności to 150,000 Mg — trzy miejsca po przecinku,
    // a nie sto pięćdziesiąt tysięcy. Ta pomyłka jest łatwa i kosztowna,
    // więc wiersz sprawdzamy w całości.
    const wiersz = screen.getByText('PRZYJ').closest('div')?.parentElement
    const tresc = (wiersz?.textContent ?? '').replace(/\s+/g, ' ')
    expect(tresc).toContain('117,665 Mg')
    expect(tresc).toContain('150,000 Mg')
  })

  it('ostrzega o frakcji poniżej progu wysyłki', async () => {
    render(<SortowniaDashboard />)
    expect(await screen.findByText('Frakcje poniżej progu wysyłki')).toBeInTheDocument()
    expect(screen.getByText(/Papier i tektura \(4,000 Mg/)).toBeInTheDocument()
  })

  it('nie wyświetla ostrzeżenia, gdy wszystkie frakcje są nad progiem', async () => {
    respondWith({
      ...payload,
      fractions: payload.fractions.map((row) => ({ ...row, belowReorderPoint: false })),
    })
    render(<SortowniaDashboard />)
    await screen.findByText('Na placu przyjęć')
    expect(screen.queryByText('Frakcje poniżej progu wysyłki')).not.toBeInTheDocument()
  })

  it('tłumaczy kierunek ruchu na język operatora zamiast pokazywać konwencję WMS', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Ostatnie ruchy')
    // Korekta wydania trzyma lokalizację w polu „do", ale towar z boksu wyjechał.
    expect(screen.getByText('BOKS1 → odbiorca')).toBeInTheDocument()
    expect(screen.getByText('PRZYJ → BOKS1')).toBeInTheDocument()
  })

  it('niesie numer z systemu legacy — para SORT pokazuje oba', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Ostatnie ruchy')
    expect(screen.getByText('#100240 + 100241')).toBeInTheDocument()
    expect(screen.getByText('#100237')).toBeInTheDocument()
  })

  it('nazywa operacje po polsku i dokłada skrót dokumentu z legacy', async () => {
    render(<SortowniaDashboard />)
    await screen.findByText('Ostatnie ruchy')
    expect(screen.getByText('Sortowanie')).toBeInTheDocument()
    expect(screen.getByText('SORT')).toBeInTheDocument()
    expect(screen.getByText('WZ')).toBeInTheDocument()
  })

  it('pokazuje przepływ frakcji jako wykres', async () => {
    render(<SortowniaDashboard />)
    const chart = await screen.findByTestId('chart')
    expect(chart).toHaveAttribute('data-rows', '1')
  })

  it('mówi wprost, gdy dane się nie pobrały — pusty ekran niczego nie tłumaczy', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) })
    render(<SortowniaDashboard />)
    expect(await screen.findByText('Forbidden')).toBeInTheDocument()
  })

  it('podpowiada import, gdy księga jest pusta', async () => {
    respondWith({ ...payload, movements: [], locations: [], fractions: [], flow: [] })
    render(<SortowniaDashboard />)
    expect(await screen.findByText(/Księga jest pusta/)).toBeInTheDocument()
    expect(screen.getByText(/Brak lokalizacji/)).toBeInTheDocument()
  })
})
