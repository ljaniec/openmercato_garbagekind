import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'sortownia',
  title: 'Sortownia odpadów',
  version: '0.1.0',
  description:
    'Most między systemem legacy sortowni a WMS: topologia magazynu, frakcje jako pozycje katalogu i księga ruchów.',
  author: 'machinekind',
  license: 'MIT',
  requires: ['wms', 'catalog', 'data_sync'],
}

export { features } from './acl'

export default metadata
