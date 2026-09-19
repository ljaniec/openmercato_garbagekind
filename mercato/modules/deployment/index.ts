import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'deployment',
  title: 'Stan pożądany',
  version: '0.1.0',
  description:
    'Przypisanie wersji polityki do robota, dzierżawa o długości zależnej od klasy ryzyka celi i uzgadnianie stanu faktycznego.',
  author: 'machinekind',
  license: 'MIT',
  /**
   * Trzy zależności, każda po co innego i każda jednostronna:
   * `fleet` — stan robota i klasa ryzyka celi,
   * `policy_registry` — co wolno wdrożyć,
   * `edge` — czyim kluczem zweryfikować żądanie dzierżawy.
   *
   * Żaden z tych modułów nie wie o wdrożeniu i tak ma zostać. Rejestr floty
   * działa bez jednej wdrożonej polityki, kanał brzegowy bez jednej dzierżawy.
   */
  requires: ['fleet', 'policy_registry', 'edge'],
  ejectable: true,
}

export { features } from './acl'
