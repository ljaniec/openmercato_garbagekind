import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'vision',
  title: 'Wzrok maszynowy',
  version: '0.1.0',
  description: 'Kamery, detektory i zliczenia obiektów jako trzeci świadek obok deklaracji robota i wagi.',
  author: 'machinekind',
  license: 'MIT',
  /** Kamera należy do celi, więc rejestr floty jest wymagany. Wideo nie tu. */
  requires: ['fleet'],
  ejectable: true,
}

export { features } from './acl'
