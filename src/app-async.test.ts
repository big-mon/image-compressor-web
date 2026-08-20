import { describe, expect, it } from 'vitest'

import { isSameResultIntent, type ResultIntent } from './app-async'

function createIntent(): ResultIntent {
  return {
    source: {},
    edit: {},
    outputMime: 'image/jpeg',
    quality: 0.82,
  }
}

describe('App result intent', () => {
  it('accepts the same source, edit, and output intent', () => {
    const intent = createIntent()

    expect(isSameResultIntent(intent, intent)).toBe(true)
  })

  it.each([
    ['source', (intent: ResultIntent) => ({ ...intent, source: {} })],
    ['edit', (intent: ResultIntent) => ({ ...intent, edit: {} })],
    ['output MIME', (intent: ResultIntent) => ({ ...intent, outputMime: 'image/png' })],
    ['quality', (intent: ResultIntent) => ({ ...intent, quality: 0.5 })],
  ])('rejects a changed %s', (_label, change) => {
    const intent = createIntent()

    expect(isSameResultIntent(change(intent), intent)).toBe(false)
  })
})
