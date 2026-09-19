import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'edge',
  title: 'Kanał brzegowy',
  version: '0.1.0',
  description: 'Tożsamość kryptograficzna agenta na robocie, sesje łączności i uderzenia serca.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * Zależność jest jednostronna i taka ma zostać: agent bez robota nie ma
   * sensu, robot bez agenta owszem — flota inwentaryzowana ręcznie to
   * najczęstszy punkt wyjścia każdego wdrożenia.
   */
  requires: ['fleet'],
  ejectable: true,
}

export { features } from './acl'
