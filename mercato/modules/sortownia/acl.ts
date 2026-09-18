import type { FeatureDefinition } from '@open-mercato/shared/security/features'

export const features: FeatureDefinition[] = [
  {
    id: 'sortownia.view',
    module: 'sortownia',
    title: 'Podgląd pulpitu sortowni',
    description: 'Dostęp do pulpitu z zapełnieniem boksów i przepływem frakcji.',
  },
  {
    id: 'sortownia.sync',
    module: 'sortownia',
    title: 'Uruchamianie importu z systemu legacy',
    description: 'Pozwala wywołać synchronizację danych ze starego systemu sortowni.',
  },
]

export default features
