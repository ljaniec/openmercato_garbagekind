import { applySalesOrders, orderNumberFor, VAT_RATE } from '../salesOrders'
import type { LegacyOrderRow } from '../legacyFiles'

/**
 * Wydanie odpadu staje się dokumentem sprzedaży. Najłatwiej zepsuć tu trzy
 * rzeczy naraz: jednostkę (magazyn liczy kilogramy, faktura sztuki), cenę
 * (za kilogram czy za całość) i powiązania (frakcja, kontrahent). Każda z nich
 * ma tutaj swój test, bo każda kończy się błędną fakturą u odbiorcy.
 */

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }

function order(overrides: Partial<LegacyOrderRow> = {}): LegacyOrderRow {
  return {
    orderno: 5001,
    debtorno: 'D005',
    dataZamowienia: '2026-08-20',
    dataWydania: '2026-08-22',
    stockid: '20 01 01',
    iloscKg: 4548,
    cenaKg: 0.432,
    ...overrides,
  }
}

function makeCtx(options: { existing?: Array<{ id: string; externalReference: string }>; issueInvoices?: boolean } = {}) {
  const calls: Array<{ id: string; input: Record<string, unknown> }> = []
  let counter = 0
  return {
    calls,
    ctx: {
      em: { find: jest.fn(async () => options.existing ?? []) } as never,
      commandBus: {
        execute: jest.fn(async (id: string, payload: { input: Record<string, unknown> }) => {
          calls.push({ id, input: payload.input })
          counter += 1
          return { result: { orderId: `ord-${counter}`, invoiceId: `inv-${counter}` }, logEntry: null }
        }),
      } as never,
      commandContext: {} as never,
      scope,
      customers: new Map([['D005', 'ent-5']]),
      fractions: new Map([['20 01 01', { productId: 'p-1', variantId: 'v-1' }]]),
      issueInvoices: options.issueInvoices ?? true,
    },
  }
}

describe('orderNumberFor', () => {
  it('numer dokumentu odtwarza się z numeru legacy — na tym stoi idempotencja', () => {
    expect(orderNumberFor(5001)).toBe('WZ/5001')
  })
})

describe('applySalesOrders', () => {
  it('zakłada zamówienie komendą sprzedaży', async () => {
    const { ctx, calls } = makeCtx({ issueInvoices: false })
    await applySalesOrders(ctx, [order()])
    expect(calls.map((call) => call.id)).toEqual(['sales.orders.create'])
  })

  it('pozycja idzie w kilogramach, bo w takich jednostkach prowadzony jest magazyn', async () => {
    const { ctx, calls } = makeCtx({ issueInvoices: false })
    await applySalesOrders(ctx, [order()])
    const line = (calls[0].input.lines as Array<Record<string, unknown>>)[0]
    expect(line).toMatchObject({ quantity: 4548, quantityUnit: 'kg' })
  })

  it('cena jest ceną za kilogram, a nie za całe wydanie', async () => {
    const { ctx, calls } = makeCtx({ issueInvoices: false })
    await applySalesOrders(ctx, [order()])
    const line = (calls[0].input.lines as Array<Record<string, unknown>>)[0]
    // 4548 kg × 0,432 zł/kg = 1964,74 zł netto. Gdyby cena była za całość,
    // faktura opiewałaby na 4548 × 1964,74 — pomyłka o trzy rzędy wielkości.
    expect(line.unitPriceNet).toBe(0.432)
    expect(line.priceMode).toBe('net')
  })

  it('pozycja wskazuje wariant katalogowy frakcji, a nie samą nazwę', async () => {
    const { ctx, calls } = makeCtx({ issueInvoices: false })
    await applySalesOrders(ctx, [order()])
    const line = (calls[0].input.lines as Array<Record<string, unknown>>)[0]
    expect(line).toMatchObject({ productId: 'p-1', productVariantId: 'v-1' })
  })

  it('zamówienie wskazuje kontrahenta z CRM', async () => {
    const { ctx, calls } = makeCtx({ issueInvoices: false })
    await applySalesOrders(ctx, [order()])
    expect(calls[0].input.customerEntityId).toBe('ent-5')
  })

  it('dokłada stawkę VAT do pozycji', async () => {
    const { ctx, calls } = makeCtx({ issueInvoices: false })
    await applySalesOrders(ctx, [order()])
    const line = (calls[0].input.lines as Array<Record<string, unknown>>)[0]
    expect(line.taxRate).toBe(VAT_RATE)
  })

  it('wystawia fakturę do zamówienia i nie nadaje jej numeru sama', async () => {
    const { ctx, calls } = makeCtx()
    const result = await applySalesOrders(ctx, [order()])
    expect(calls.map((call) => call.id)).toEqual(['sales.orders.create', 'sales.invoices.create'])
    expect(calls[1].input.orderId).toBe('ord-1')
    // Numerowanie dokumentów to zadanie platformy — własny licznik rozjechałby
    // się z numeracją reszty sprzedaży przy pierwszej fakturze spoza importu.
    expect(calls[1].input).not.toHaveProperty('invoiceNumber')
    expect(result.outcomes[0].invoiced).toBe(true)
  })

  it('wyłączone fakturowanie zostawia samo zamówienie', async () => {
    const { ctx, calls } = makeCtx({ issueInvoices: false })
    const result = await applySalesOrders(ctx, [order()])
    expect(calls).toHaveLength(1)
    expect(result.outcomes[0].invoiced).toBe(false)
  })

  it('drugi przebieg nie wystawia drugiej faktury za to samo wydanie', async () => {
    const { ctx, calls } = makeCtx({ existing: [{ id: 'ord-9', externalReference: '5001' }] })
    const result = await applySalesOrders(ctx, [order()])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0]).toMatchObject({ action: 'skip', orderId: 'ord-9' })
  })

  it('brak frakcji w katalogu zatrzymuje zamówienie z czytelnym powodem', async () => {
    const { ctx, calls } = makeCtx()
    const result = await applySalesOrders(ctx, [order({ stockid: '99 99 99' })])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('failed')
    expect(result.outcomes[0].error).toContain('99 99 99')
  })

  it('brak kontrahenta w CRM zatrzymuje zamówienie zamiast wystawiać fakturę w próżnię', async () => {
    const { ctx, calls } = makeCtx()
    const result = await applySalesOrders(ctx, [order({ debtorno: 'D999' })])
    expect(calls).toHaveLength(0)
    expect(result.outcomes[0].action).toBe('failed')
    expect(result.outcomes[0].error).toContain('D999')
  })

  it('niesie numer legacy w metadanych i w polu referencji', async () => {
    const { ctx, calls } = makeCtx({ issueInvoices: false })
    await applySalesOrders(ctx, [order()])
    expect(calls[0].input.externalReference).toBe('5001')
    expect(calls[0].input.orderNumber).toBe('WZ/5001')
  })

  it('zwraca indeks zamówień, po którym ruch WZ odnajduje swój dokument', async () => {
    const { ctx } = makeCtx({ issueInvoices: false })
    const result = await applySalesOrders(ctx, [order()])
    expect(result.index.get(5001)).toBe('ord-1')
  })

  it('błąd jednego zamówienia nie zatrzymuje pozostałych', async () => {
    const { ctx } = makeCtx({ issueInvoices: false })
    ;(ctx.commandBus as unknown as { execute: jest.Mock }).execute.mockRejectedValueOnce(
      new Error('sprzedaż niedostępna'),
    )
    const result = await applySalesOrders(ctx, [order(), order({ orderno: 5002 })])
    expect(result.outcomes[0].action).toBe('failed')
    expect(result.outcomes[1].action).toBe('create')
  })
})
