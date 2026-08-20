import { afterEach, describe, expect, it, vi } from 'vitest'

import { createEditState } from './geometry'
import { createRasterProcessor } from './raster'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly messages: unknown[] = []
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.instances = []
})

describe('RasterProcessor clear lifecycle', () => {
  it('settles pending work and sends an explicit clear generation', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const processor = createRasterProcessor()
    const worker = FakeWorker.instances[0]
    if (!worker) {
      throw new Error('Fake worker was not created.')
    }

    const pending = processor.process(
      {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray(2 * 2 * 4),
      },
      createEditState({ width: 2, height: 2 }),
      { mimeType: 'image/png', preview: true },
    )
    let rejected = false
    void pending.catch(() => {
      rejected = true
    })

    processor.clearSource()
    await Promise.resolve()

    expect(rejected).toBe(true)
    expect(worker.messages.at(-1)).toEqual({ type: 'clear', generation: 1 })
    processor.dispose()
  })
})
