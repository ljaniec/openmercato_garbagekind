import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'reality_layer',
  title: 'Reality Layer',
  version: '0.1.0',
  description:
    'Trusted boundary between semantic ERP intent, physical execution evidence, and reconciled business truth.',
  author: 'machinekind',
  license: 'MIT',
  requires: [],
  ejectable: true,
}

export { features } from './acl'
