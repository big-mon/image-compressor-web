export interface LatestOnlyRequest {
  readonly requestId: number
  readonly generation: number
}

export interface LatestOnlyState<T extends LatestOnlyRequest> {
  readonly generation: number
  readonly active: T | undefined
  readonly queued: T | undefined
  readonly latestRequestId: number
}

export type LatestOnlyEvent<T extends LatestOnlyRequest> =
  | { readonly type: 'start'; readonly request: T }
  | { readonly type: 'stale'; readonly requestId: number }
  | { readonly type: 'current'; readonly request: T }

export interface LatestOnlyTransition<T extends LatestOnlyRequest> {
  readonly state: LatestOnlyState<T>
  readonly events: readonly LatestOnlyEvent<T>[]
}

export function createLatestOnlyState<T extends LatestOnlyRequest>(generation = 0): LatestOnlyState<T> {
  return {
    generation,
    active: undefined,
    queued: undefined,
    latestRequestId: 0,
  }
}

export function enqueueLatest<T extends LatestOnlyRequest>(
  state: LatestOnlyState<T>,
  request: T,
): LatestOnlyTransition<T> {
  if (request.generation !== state.generation || request.requestId <= state.latestRequestId) {
    return {
      state,
      events: [{ type: 'stale', requestId: request.requestId }],
    }
  }

  if (state.active === undefined) {
    return {
      state: {
        ...state,
        active: request,
        latestRequestId: request.requestId,
      },
      events: [{ type: 'start', request }],
    }
  }

  const events: LatestOnlyEvent<T>[] = []
  if (state.queued !== undefined) {
    events.push({ type: 'stale', requestId: state.queued.requestId })
  }
  return {
    state: {
      ...state,
      queued: request,
      latestRequestId: request.requestId,
    },
    events,
  }
}

export function completeLatest<T extends LatestOnlyRequest>(
  state: LatestOnlyState<T>,
  requestId: number,
): LatestOnlyTransition<T> {
  if (state.active === undefined || state.active.requestId !== requestId) {
    return {
      state,
      events: [{ type: 'stale', requestId }],
    }
  }

  if (state.queued !== undefined) {
    const nextRequest = state.queued
    return {
      state: {
        ...state,
        active: nextRequest,
        queued: undefined,
      },
      events: [
        { type: 'stale', requestId },
        { type: 'start', request: nextRequest },
      ],
    }
  }

  return {
    state: {
      ...state,
      active: undefined,
    },
    events: state.active.generation === state.generation
      ? [{ type: 'current', request: state.active }]
      : [{ type: 'stale', requestId }],
  }
}

export function clearLatest<T extends LatestOnlyRequest>(
  state: LatestOnlyState<T>,
  generation: number,
): LatestOnlyTransition<T> {
  if (!Number.isInteger(generation) || generation <= state.generation) {
    return { state, events: [] }
  }

  const events: LatestOnlyEvent<T>[] = []
  if (state.queued !== undefined) {
    events.push({ type: 'stale', requestId: state.queued.requestId })
  }
  return {
    state: {
      ...state,
      generation,
      active: state.active,
      queued: undefined,
    },
    events,
  }
}
