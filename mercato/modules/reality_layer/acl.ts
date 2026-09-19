export const features = [
  { id: 'reality_layer.intent.view', title: 'View physical intents', module: 'reality_layer' },
  { id: 'reality_layer.intent.create', title: 'Create physical intents', module: 'reality_layer' },
  {
    id: 'reality_layer.authorization.grant',
    title: 'Grant physical authorization',
    module: 'reality_layer',
    dependsOn: ['reality_layer.intent.view'],
  },
  {
    id: 'reality_layer.execution.dispatch',
    title: 'Dispatch authorized physical execution',
    module: 'reality_layer',
    dependsOn: ['reality_layer.intent.view'],
  },
  { id: 'reality_layer.executor.view', title: 'View physical executors', module: 'reality_layer' },
  { id: 'reality_layer.evidence.view', title: 'View physical evidence', module: 'reality_layer' },
  { id: 'reality_layer.diff.view', title: 'View reality diffs', module: 'reality_layer' },
  {
    id: 'reality_layer.reconciliation.decide',
    title: 'Decide reality reconciliation',
    module: 'reality_layer',
    dependsOn: ['reality_layer.diff.view'],
  },
]

export default features
