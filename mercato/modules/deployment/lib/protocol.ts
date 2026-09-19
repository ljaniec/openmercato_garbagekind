/**
 * Kanoniczna postać komunikatów kanału stanu pożądanego.
 *
 * Własny przedrostek, mimo że weryfikacja idzie kluczem z modułu `edge`.
 * To jest wiązanie kontekstu: podpis zebrany przy uderzeniu serca nie może
 * być przedstawiony jako żądanie dzierżawy. Bez przedrostka ktoś, kto
 * przechwyci jeden heartbeat, przedłużyłby sobie mandat do pracy.
 */
export const leasePayload = (sessionId: string, sequence: number, timestampIso: string): string =>
  `deployment.lease:${sessionId}:${sequence}:${timestampIso}`

export const reportPayload = (sessionId: string, state: string, timestampIso: string): string =>
  `deployment.report:${sessionId}:${state}:${timestampIso}`
