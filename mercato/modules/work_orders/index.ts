import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'work_orders',
  title: 'Zlecenia robocze',
  version: '0.1.0',
  description: 'Most hala ↔ przedsiębiorstwo: praca robota staje się masą w magazynie, a waga sprawdza robota.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * Jedyny moduł w tym repozytorium, który wymaga obu światów naraz.
   * `sortownia` nie jest wymieniona celowo: most potrzebuje katalogu
   * i magazynu platformy, a nie konkretnego wdrożenia sortowni.
   */
  requires: ['fleet', 'episodes', 'catalog', 'wms'],
  ejectable: true,
}

export { features } from './acl'
