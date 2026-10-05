// @vitest-environment jsdom
/** Saved configuration changes require a status read newer than any previous poll. */
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsController } from '../src/client/settings-controller.ts'
import type { RainyModelSetup, SettingsStatus } from '../src/client/settings-protocol.ts'

const controllers: SettingsController[] = []
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.unstubAllGlobals() })

function status(model: string): SettingsStatus {
  return { selected: { provider: 'local', model },
    models: [{ provider: 'local', baseURL: 'http://127.0.0.1:8081/v1', model, contextWindow: 32768, local: true }],
    budgets: [], sessions: [], tools: [] }
}

it('does not reuse a pre-save poll as the saved model status', async () => {
  const earlier = Promise.withResolvers<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(earlier.promise)
    .mockResolvedValueOnce(Response.json({ result: { provider: 'local', model: 'new-model' } }))
    .mockResolvedValueOnce(Response.json(status('new-model')))
  vi.stubGlobal('fetch', fetch)
  const controller = new SettingsController()
  controllers.push(controller)
  const poll = controller.refresh()
  const setup: RainyModelSetup = status('new-model').models[0]!
  const saved = controller.operations.configure(setup)
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
  earlier.resolve(Response.json(status('old-model')))
  await Promise.all([poll, saved])
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(controller.state.getSnapshot().status?.selected).toEqual({ provider: 'local', model: 'new-model' })
})

it('does not start a replacement status request after disposal', async () => {
  const earlier = Promise.withResolvers<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(earlier.promise)
  vi.stubGlobal('fetch', fetch)
  const controller = new SettingsController()
  controllers.push(controller)
  const poll = controller.refresh()
  const changed = controller.refreshAfterChange()
  controller.dispose()
  earlier.resolve(Response.json(status('new-model')))
  await Promise.all([poll, changed])
  expect(fetch).toHaveBeenCalledOnce()
  expect(controller.state.getSnapshot().status).toBeUndefined()
})
