import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  {
    id: 'reality_layer.intent.blocked',
    label: 'Physical intent blocked',
    entity: 'intent',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'reality_layer.intent.authorized',
    label: 'Physical intent authorized',
    entity: 'intent',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'reality_layer.execution.finished',
    label: 'Physical execution finished',
    entity: 'execution',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'reality_layer.evidence.recorded',
    label: 'Physical evidence recorded',
    entity: 'evidence',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'reality_layer.diff.proposed',
    label: 'Reality diff proposed',
    entity: 'diff',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'reality_layer.diff.merged',
    label: 'Reality diff merged',
    entity: 'diff',
    category: 'lifecycle',
    clientBroadcast: true,
  },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'reality_layer',
  events,
})

export const emitRealityLayerEvent = eventsConfig.emit
export type RealityLayerEventId = typeof events[number]['id']

export default eventsConfig
