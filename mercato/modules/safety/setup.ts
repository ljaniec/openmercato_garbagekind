import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * `employee` widzi, zgłasza incydenty i zapisuje przebiegi ewaluacyjne,
 * ale **nie zatwierdza** uzasadnień. Zatwierdzenie jest podpisem pod
 * dokumentem regulacyjnym, a nie czynnością operacyjną.
 *
 * Zgłaszanie incydentów nadane szeroko z premedytacją: incydent, którego
 * zgłoszenie wymaga proszenia o dostęp, bywa niezgłaszany.
 *
 * Kontrakt generatora: rejestr czyta `default` albo nazwany `setup`.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['safety.*'],
    employee: ['safety.view', 'safety.evaluate', 'safety.incidents.report'],
  },
}

export default setup
