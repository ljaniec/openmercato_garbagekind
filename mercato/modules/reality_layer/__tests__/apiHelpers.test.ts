import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { runRealityMutation } from '../api/helpers'

jest.mock('@open-mercato/shared/lib/crud/route-mutation-guard', () => ({
  runRouteMutationGuards: jest.fn(),
}))

describe('Reality Layer API mutation boundary', () => {
  it('executes the command with mutation-guard payload transforms applied', async () => {
    const execute = jest.fn(async (_commandId: string, options: unknown) => ({
      result: { ok: true, options },
    }))
    const runAfterSuccess = jest.fn(async () => undefined)

    ;(runRouteMutationGuards as jest.Mock).mockResolvedValue({
      ok: true,
      modifiedPayload: {
        constrained: 'from-guard',
        untouchedByGuard: 'guard-value',
      },
      runAfterSuccess,
    })

    const ctx = {
      container: {
        resolve: (key: string) => {
          if (key === 'commandBus') return { execute }
          throw new Error('Unexpected service: ' + key)
        },
      },
      auth: {
        sub: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
        orgId: '33333333-3333-4333-8333-333333333333',
      },
      selectedOrganizationId: '33333333-3333-4333-8333-333333333333',
    } as never

    const request = new Request('http://localhost/api/reality_layer/test', {
      method: 'POST',
    })

    await runRealityMutation(
      request,
      ctx,
      'reality_layer.test',
      {
        constrained: 'original',
        originalOnly: 'preserved',
      },
      'reality_layer.test',
      null,
      'create',
    )

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      input: {
        constrained: 'from-guard',
        untouchedByGuard: 'guard-value',
        originalOnly: 'preserved',
      },
      ctx,
    })
    expect(runAfterSuccess).toHaveBeenCalledTimes(1)
  })
})
