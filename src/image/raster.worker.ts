import { stripEncodedMetadata } from './encoded-metadata'
import {
  createProcessingPlan,
  validateWorkerClearRequest,
  validateWorkerRequest,
  type WorkerProcessRequest,
} from './worker-protocol'
import type { OutputMime } from './raster-utils'
import {
  clearLatest,
  completeLatest,
  createLatestOnlyState,
  enqueueLatest,
  type LatestOnlyEvent,
  type LatestOnlyState,
} from './worker-scheduler'

interface CachedSource {
  readonly key: string
  readonly width: number
  readonly height: number
  readonly data: ArrayBuffer
}

interface WorkerResultMessage {
  readonly type: 'result'
  readonly requestId: number
  readonly blob: Blob
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly mimeType: OutputMime
}

interface WorkerErrorMessage {
  readonly type: 'error'
  readonly requestId: number
  readonly message: string
}

interface WorkerStaleMessage {
  readonly type: 'stale'
  readonly requestId: number
}

type WorkerResponseMessage = WorkerResultMessage | WorkerErrorMessage | WorkerStaleMessage

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: WorkerResponseMessage): void
}

const workerScope = self as unknown as WorkerScope
let cachedSource: CachedSource | undefined
let scheduler: LatestOnlyState<WorkerProcessRequest> = createLatestOnlyState()

function getContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) {
    throw new Error('このブラウザでは画像処理用のCanvasを初期化できません。')
  }
  return context
}

function createCanvas(width: number, height: number): OffscreenCanvas {
  if (width < 1 || height < 1) {
    throw new Error('画像の出力サイズが不正です。')
  }
  return new OffscreenCanvas(width, height)
}

function drawNormalizedSource(source: CachedSource): OffscreenCanvas {
  const canvas = createCanvas(source.width, source.height)
  const context = getContext(canvas)
  const pixels = new Uint8ClampedArray(source.data)
  context.putImageData(new ImageData(pixels, source.width, source.height), 0, 0)
  return canvas
}

async function render(request: WorkerProcessRequest, source: CachedSource): Promise<WorkerResultMessage> {
  const plan = createProcessingPlan(
    { width: source.width, height: source.height },
    request.state,
    request.output,
  )
  const sourceCanvas = drawNormalizedSource(source)
  const outputCanvas = createCanvas(plan.renderSize.width, plan.renderSize.height)
  const outputContext = getContext(outputCanvas)
  outputContext.imageSmoothingEnabled = true
  outputContext.imageSmoothingQuality = 'high'
  const { crop, displaySize, straightening } = plan.geometry
  // Map source pixels directly into the output crop. Never allocate the expanded
  // bounding rectangle: a tilted panorama can make that rectangle enormous.
  outputContext.scale(plan.renderSize.width / crop.width, plan.renderSize.height / crop.height)
  outputContext.translate(displaySize.width / 2 - crop.x, displaySize.height / 2 - crop.y)
  outputContext.scale(request.state.flipHorizontal ? -1 : 1, request.state.flipVertical ? -1 : 1)
  outputContext.rotate((request.state.rotation + straightening.degrees) * Math.PI / 180)
  outputContext.scale(straightening.scale, straightening.scale)
  outputContext.drawImage(sourceCanvas, -source.width / 2, -source.height / 2)

  const blobOptions: ImageEncodeOptions = { type: request.output.mimeType }
  if (request.output.quality !== undefined) {
    blobOptions.quality = request.output.quality
  }
  const blob = await outputCanvas.convertToBlob(blobOptions)
  if (blob.type !== request.output.mimeType) {
    throw new Error(`${request.output.mimeType} のエンコードに対応していません。`)
  }

  let strippedBytes: Uint8Array
  try {
    strippedBytes = stripEncodedMetadata(
      new Uint8Array(await blob.arrayBuffer()),
      request.output.mimeType,
    )
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(`${request.output.mimeType} のエンコード結果を検証できず、メタデータを安全に除去できませんでした${cause}`)
  }
  const strippedBuffer = new ArrayBuffer(strippedBytes.byteLength)
  new Uint8Array(strippedBuffer).set(strippedBytes)
  const strippedBlob = new Blob([strippedBuffer], { type: request.output.mimeType })
  if (strippedBlob.type !== request.output.mimeType) {
    throw new Error(`${request.output.mimeType} のメタデータ除去後 Blob を作成できませんでした。`)
  }

  return {
    type: 'result',
    requestId: request.requestId,
    blob: strippedBlob,
    width: plan.renderSize.width,
    height: plan.renderSize.height,
    bytes: strippedBlob.size,
    mimeType: request.output.mimeType,
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '画像処理中に予期しないエラーが発生しました。'
}

type RenderOutcome =
  | { readonly type: 'result'; readonly result: WorkerResultMessage }
  | { readonly type: 'error'; readonly message: string }

function postSchedulerEvent(event: LatestOnlyEvent<WorkerProcessRequest>): void {
  if (event.type === 'stale') {
    workerScope.postMessage({ type: 'stale', requestId: event.requestId })
    return
  }
  if (event.type === 'start') {
    startRequest(event.request)
  }
}

function finishRequest(requestId: number, outcome: RenderOutcome): void {
  const transition = completeLatest(scheduler, requestId)
  scheduler = transition.state
  for (const event of transition.events) {
    if (event.type === 'current') {
      if (outcome.type === 'result') {
        workerScope.postMessage(outcome.result)
      } else {
        workerScope.postMessage({
          type: 'error',
          requestId,
          message: outcome.message,
        })
      }
      continue
    }
    postSchedulerEvent(event)
  }
}

function startRequest(request: WorkerProcessRequest): void {
  const source = cachedSource
  if (source === undefined || source.key !== request.sourceKey) {
    finishRequest(request.requestId, {
      type: 'error',
      message: '処理対象の画像データが見つかりません。画像を選び直してください。',
    })
    return
  }

  void render(request, source)
    .then((result) => finishRequest(request.requestId, { type: 'result', result }))
    .catch((error: unknown) => finishRequest(request.requestId, {
      type: 'error',
      message: getErrorMessage(error),
    }))
}

function applyEnqueueEvents(events: readonly LatestOnlyEvent<WorkerProcessRequest>[]): void {
  for (const event of events) {
    postSchedulerEvent(event)
  }
}

workerScope.onmessage = (event) => {
  const value = event.data
  if (value && typeof value === 'object' && 'type' in value && value.type === 'clear') {
    let clearRequest
    try {
      clearRequest = validateWorkerClearRequest(value)
    } catch (error) {
      workerScope.postMessage({ type: 'error', requestId: 0, message: getErrorMessage(error) })
      return
    }

    const transition = clearLatest(scheduler, clearRequest.generation)
    scheduler = transition.state
    cachedSource = undefined
    applyEnqueueEvents(transition.events)
    return
  }

  let request: WorkerProcessRequest
  try {
    request = validateWorkerRequest(value)
  } catch (error) {
    const requestId = value && typeof value === 'object' && 'requestId' in value && typeof value.requestId === 'number'
      ? value.requestId
      : 0
    workerScope.postMessage({ type: 'error', requestId, message: getErrorMessage(error) })
    return
  }

  const canEnqueue = request.generation === scheduler.generation && request.requestId > scheduler.latestRequestId
  const transition = enqueueLatest(scheduler, request)
  if (!canEnqueue) {
    applyEnqueueEvents(transition.events)
    return
  }

  if (request.source !== undefined) {
    cachedSource = {
      key: request.sourceKey,
      width: request.source.width,
      height: request.source.height,
      data: request.source.data,
    }
  }

  scheduler = transition.state
  applyEnqueueEvents(transition.events)
}
