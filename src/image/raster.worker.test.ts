import { afterEach, expect, it, vi } from 'vitest'

import { createEditState, straightenEditState } from './geometry'
import { createProcessingPlan } from './worker-protocol'

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])('bounds panorama Canvas allocations to source and requested output (preview=%s)', async preview => {
  vi.resetModules()
  const sizes: { width: number; height: number }[] = []
  const context = { putImageData: vi.fn(), scale: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn() }
  vi.stubGlobal('ImageData', class {})
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width: number, height: number) { sizes.push({ width, height }) }
    getContext() { return context }
    convertToBlob() { throw new Error('stop after rendering') }
  })
  const scope = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() }
  vi.stubGlobal('self', scope)
  await import('./raster.worker')
  const sourceSize = { width: 12000, height: 1000 }
  const state = { ...straightenEditState(sourceSize, createEditState(sourceSize), 45), resize: { width: 256 } }
  const output = { mimeType: 'image/png' as const, preview, maxPreviewDimension: 128 }
  const plan = createProcessingPlan(sourceSize, state, output)
  scope.onmessage?.({ data: { type: 'process', requestId: 1, generation: 0, sourceKey: 'panorama',
    source: { ...sourceSize, data: new ArrayBuffer(12000 * 1000 * 4) }, state, output } })
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith({ type: 'error', requestId: 1, message: 'stop after rendering' }))
  expect(sizes).toEqual([sourceSize, plan.renderSize])
  expect(context.drawImage).toHaveBeenCalledTimes(1)
})
