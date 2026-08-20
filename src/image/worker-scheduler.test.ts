import { describe, expect, it } from 'vitest'

import {
  clearLatest,
  completeLatest,
  createLatestOnlyState,
  enqueueLatest,
  type LatestOnlyRequest,
} from './worker-scheduler'

interface TestRequest extends LatestOnlyRequest {
  readonly label: string
}

function request(requestId: number, generation = 0): TestRequest {
  return { requestId, generation, label: `request-${requestId}` }
}

describe('latest-only worker scheduler', () => {
  it('replaces a queued request and reports the replaced request as stale', () => {
    let state = createLatestOnlyState<TestRequest>()
    state = enqueueLatest(state, request(1)).state
    state = enqueueLatest(state, request(2)).state

    const replacement = enqueueLatest(state, request(3))

    expect(replacement.events).toEqual([{ type: 'stale', requestId: 2 }])
    expect(replacement.state.active?.requestId).toBe(1)
    expect(replacement.state.queued?.requestId).toBe(3)
  })

  it('starts the latest queued request after the active request becomes stale', () => {
    let state = createLatestOnlyState<TestRequest>()
    state = enqueueLatest(state, request(1)).state
    state = enqueueLatest(state, request(2)).state

    const activeCompletion = completeLatest(state, 1)

    expect(activeCompletion.events).toEqual([
      { type: 'stale', requestId: 1 },
      { type: 'start', request: request(2) },
    ])
    expect(activeCompletion.state.active?.requestId).toBe(2)
    expect(activeCompletion.state.queued).toBeUndefined()

    const latestCompletion = completeLatest(activeCompletion.state, 2)
    expect(latestCompletion.events).toEqual([{ type: 'current', request: request(2) }])
    expect(latestCompletion.state.active).toBeUndefined()
  })

  it('keeps the active render occupied across a clear until the next generation starts', () => {
    let state = createLatestOnlyState<TestRequest>()
    state = enqueueLatest(state, request(1)).state

    const cleared = clearLatest(state, 1)

    expect(cleared.events).toEqual([])
    expect(cleared.state.generation).toBe(1)
    expect(cleared.state.active?.requestId).toBe(1)
    expect(cleared.state.queued).toBeUndefined()

    const queued = enqueueLatest(cleared.state, request(2, 1))
    expect(queued.events).toEqual([])
    expect(queued.state.active?.requestId).toBe(1)
    expect(queued.state.queued?.requestId).toBe(2)

    const activeCompletion = completeLatest(queued.state, 1)
    expect(activeCompletion.events).toEqual([
      { type: 'stale', requestId: 1 },
      { type: 'start', request: request(2, 1) },
    ])
    expect(activeCompletion.state.active?.requestId).toBe(2)
    expect(activeCompletion.state.queued).toBeUndefined()

    const latestCompletion = completeLatest(activeCompletion.state, 2)
    expect(latestCompletion.events).toEqual([{ type: 'current', request: request(2, 1) }])
    expect(latestCompletion.state.active).toBeUndefined()
  })

  it('stales and releases the old active render when clear leaves no queued request', () => {
    let state = createLatestOnlyState<TestRequest>()
    state = enqueueLatest(state, request(1)).state

    const cleared = clearLatest(state, 1)
    const activeCompletion = completeLatest(cleared.state, 1)

    expect(activeCompletion.events).toEqual([{ type: 'stale', requestId: 1 }])
    expect(activeCompletion.state.active).toBeUndefined()
    expect(activeCompletion.state.queued).toBeUndefined()
  })

  it('stales queued work at an explicit clear boundary while keeping active occupancy', () => {
    let state = createLatestOnlyState<TestRequest>()
    state = enqueueLatest(state, request(1)).state
    state = enqueueLatest(state, request(2)).state

    const cleared = clearLatest(state, 1)

    expect(cleared.events).toEqual([{ type: 'stale', requestId: 2 }])
    expect(cleared.state.active?.requestId).toBe(1)
    expect(cleared.state.queued).toBeUndefined()
  })

  it('rejects requests from before the clear generation', () => {
    let state = createLatestOnlyState<TestRequest>()
    state = clearLatest(state, 2).state

    const stale = enqueueLatest(state, request(4, 1))
    expect(stale.events).toEqual([{ type: 'stale', requestId: 4 }])
    expect(stale.state.active).toBeUndefined()
  })
})
