import { features } from '../acl'
import { setup } from '../setup'
import { metadata as statusMetadata } from '../api/status/route'

describe('Reality Layer ACL contracts', () => {
  it('protects the composite status route with intent, evidence and diff view features', () => {
    expect(statusMetadata.GET.requireAuth).toBe(true)
    expect(statusMetadata.GET.requireFeatures).toEqual([
      'reality_layer.intent.view',
      'reality_layer.evidence.view',
      'reality_layer.diff.view',
    ])
  })

  it('keeps employee defaults read/create-only and reserves privileged actions', () => {
    const employee = setup.defaultRoleFeatures?.employee ?? []
    expect(employee).toEqual(
      expect.arrayContaining([
        'reality_layer.intent.view',
        'reality_layer.intent.create',
        'reality_layer.executor.view',
        'reality_layer.evidence.view',
        'reality_layer.diff.view',
      ]),
    )
    expect(employee).not.toContain('reality_layer.authorization.grant')
    expect(employee).not.toContain('reality_layer.execution.dispatch')
    expect(employee).not.toContain('reality_layer.reconciliation.decide')
  })

  it('references only declared concrete feature ids in employee defaults', () => {
    const declared = new Set(features.map((feature) => feature.id))
    for (const feature of setup.defaultRoleFeatures?.employee ?? []) {
      expect(declared.has(feature)).toBe(true)
    }
  })

  it('gives admin the module wildcard rather than enumerating drifting privileged features', () => {
    expect(setup.defaultRoleFeatures?.admin).toEqual(['reality_layer.*'])
  })
})
