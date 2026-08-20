import type { ImageEditState } from './geometry'
import {
  OUTPUT_MIME_TYPES,
  normalizeOutputOptions,
  type DecodedSourcePixels,
  type RasterOutputOptions,
  type RasterResult,
} from './raster-utils'

export {
  calculateMetrics,
  getOutputExtension,
  limitPreviewSize,
  normalizeOutputOptions,
  sanitizeDownloadFilename,
  OUTPUT_MIME_TYPES,
} from './raster-utils'
export type {
  ByteMetrics,
  DecodedSourcePixels,
  NormalizedOutputOptions,
  OutputMime,
  PreviewSizeOptions,
  RasterOutputOptions,
  RasterResult,
} from './raster-utils'

export interface RasterProcessor {
  process(
    source: DecodedSourcePixels,
    editState: ImageEditState,
    output: RasterOutputOptions,
  ): Promise<RasterResult>
  clearSource(): void
  dispose(): void
}

interface PendingResult {
  readonly resolve: (result: RasterResult) => void
  readonly reject: (error: Error) => void
}

interface WorkerResultMessage {
  readonly type: 'result'
  readonly requestId: number
  readonly blob: Blob
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly mimeType: (typeof OUTPUT_MIME_TYPES)[number]
}

interface WorkerErrorMessage {
  readonly type: 'error' | 'stale'
  readonly requestId: number
  readonly message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWorkerResult(value: unknown): value is WorkerResultMessage {
  return (
    isRecord(value) &&
    value.type === 'result' &&
    typeof value.requestId === 'number' &&
    value.blob instanceof Blob &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.bytes === 'number' &&
    OUTPUT_MIME_TYPES.includes(value.mimeType as (typeof OUTPUT_MIME_TYPES)[number])
  )
}

function isWorkerError(value: unknown): value is WorkerErrorMessage {
  return (
    isRecord(value) &&
    (value.type === 'error' || value.type === 'stale') &&
    typeof value.requestId === 'number'
  )
}

function createSourceKey(sequence: number): string {
  return `source-${sequence}`
}

function validateDecodedSource(source: DecodedSourcePixels): void {
  if (
    !Number.isInteger(source.width) ||
    source.width < 1 ||
    !Number.isInteger(source.height) ||
    source.height < 1 ||
    source.data.length !== source.width * source.height * 4
  ) {
    throw new Error('デコードされた画像ピクセルが不正です。画像を選び直してください。')
  }
}

export function createRasterProcessor(): RasterProcessor {
  const worker = new Worker(new URL('./raster.worker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, PendingResult>()
  let nextRequestId = 0
  let sourceSequence = 0
  let sourceGeneration = 0
  let sourceIdentity: DecodedSourcePixels | undefined
  let sourceKey: string | undefined
  let disposed = false

  const rejectAll = (error: Error): void => {
    for (const { reject } of pending.values()) {
      reject(error)
    }
    pending.clear()
  }

  worker.onmessage = (event: MessageEvent<unknown>) => {
    if (isWorkerResult(event.data)) {
      const entry = pending.get(event.data.requestId)
      if (!entry) {
        return
      }
      pending.delete(event.data.requestId)
      entry.resolve({
        blob: event.data.blob,
        width: event.data.width,
        height: event.data.height,
        bytes: event.data.bytes,
        mimeType: event.data.mimeType,
      })
      return
    }

    if (isWorkerError(event.data)) {
      const entry = pending.get(event.data.requestId)
      if (!entry) {
        return
      }
      pending.delete(event.data.requestId)
      entry.reject(new Error(event.data.message ?? '画像処理に失敗しました。'))
    }
  }

  worker.onerror = (event: ErrorEvent) => {
    rejectAll(new Error(event.message || '画像処理ワーカーを実行できませんでした。'))
  }

  return {
    process(source, editState, output) {
      if (disposed) {
        return Promise.reject(new Error('画像処理ワーカーは終了しています。'))
      }

      let normalizedOutput
      try {
        validateDecodedSource(source)
        normalizedOutput = normalizeOutputOptions(output)
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('画像処理の入力が不正です。'))
      }

      const requestId = ++nextRequestId
      const sourceChanged = sourceIdentity !== source
      if (sourceChanged) {
        sourceIdentity = source
        sourceKey = createSourceKey(++sourceSequence)
      }

      const sourceData = sourceChanged ? source.data.slice() : undefined
      const message = {
        type: 'process' as const,
        requestId,
        generation: sourceGeneration,
        sourceKey: sourceKey as string,
        ...(sourceData === undefined
          ? {}
          : {
              source: {
                width: source.width,
                height: source.height,
                data: sourceData.buffer as ArrayBuffer,
              },
            }),
        state: editState,
        output: normalizedOutput,
      }
      const transfer: Transferable[] = sourceData === undefined ? [] : [sourceData.buffer]

      return new Promise<RasterResult>((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        try {
          worker.postMessage(message, transfer)
        } catch (error) {
          pending.delete(requestId)
          reject(error instanceof Error ? error : new Error('画像処理を開始できませんでした。'))
        }
      })
    },

    clearSource() {
      sourceIdentity = undefined
      sourceKey = undefined
      sourceGeneration += 1
      rejectAll(new Error('画像処理は無効化されました。'))
      if (!disposed) {
        worker.postMessage({ type: 'clear', generation: sourceGeneration })
      }
    },

    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      rejectAll(new Error('画像処理ワーカーを終了しました。'))
      worker.terminate()
    },
  }
}

export function isSupportedImageMimeType(mimeType: string): mimeType is (typeof OUTPUT_MIME_TYPES)[number] {
  return OUTPUT_MIME_TYPES.includes(mimeType.toLowerCase() as (typeof OUTPUT_MIME_TYPES)[number])
}

export function hasAnimatedWebpSignature(bytes: Uint8Array): boolean {
  const hasChunk = (chunk: string): boolean => {
    const chunkBytes = Array.from(chunk, (character) => character.charCodeAt(0))
    return Array.from(bytes).some((_, index) =>
      chunkBytes.every((byte, chunkIndex) => bytes[index + chunkIndex] === byte),
    )
  }

  return hasChunk('ANIM') || hasChunk('ANMF') || (
    bytes.length > 20 &&
    bytes[12] === 0x56 &&
    bytes[13] === 0x50 &&
    bytes[14] === 0x38 &&
    bytes[15] === 0x58 &&
    ((bytes[20] ?? 0) & 0x02) === 0x02
  )
}

export function assertSupportedImageMimeType(mimeType: string): asserts mimeType is (typeof OUTPUT_MIME_TYPES)[number] {
  if (!isSupportedImageMimeType(mimeType)) {
    throw new Error('JPEG、PNG、WebP の画像だけを選択してください。')
  }
}

function readPixelsFromDrawable(
  drawable: CanvasImageSource,
  width: number,
  height: number,
): DecodedSourcePixels {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('このブラウザでは画像を読み取れません。')
  }
  context.drawImage(drawable, 0, 0, width, height)
  const imageData = context.getImageData(0, 0, width, height)
  return {
    width,
    height,
    data: new Uint8ClampedArray(imageData.data),
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('画像をデコードできませんでした。'))
    image.src = url
  })
}

export async function decodeImageFile(file: File): Promise<DecodedSourcePixels> {
  const mimeType = file.type.toLowerCase()
  assertSupportedImageMimeType(mimeType)

  if (mimeType === 'image/webp' && hasAnimatedWebpSignature(new Uint8Array(await file.arrayBuffer()))) {
    throw new Error('アニメーションWebPには対応していません。静止画を選択してください。')
  }

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    try {
      return readPixelsFromDrawable(bitmap, bitmap.width, bitmap.height)
    } finally {
      bitmap.close()
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    return readPixelsFromDrawable(image, image.naturalWidth, image.naturalHeight)
  } finally {
    URL.revokeObjectURL(url)
  }
}
