import { calculateImageGeometry, type ImageEditState, type ImageGeometry, type Size } from './geometry'
import { limitPreviewSize, OUTPUT_MIME_TYPES } from './raster-utils'
import type { NormalizedOutputOptions, OutputMime } from './raster-utils'

export interface WorkerSourcePayload {
  readonly width: number
  readonly height: number
  readonly data: ArrayBuffer
}

export interface WorkerProcessRequest {
  readonly type: 'process'
  readonly requestId: number
  readonly generation: number
  readonly sourceKey: string
  readonly source?: WorkerSourcePayload
  readonly state: ImageEditState
  readonly output: NormalizedOutputOptions
}

export interface WorkerClearRequest {
  readonly type: 'clear'
  readonly generation: number
}

export interface ProcessingPlan {
  readonly geometry: ImageGeometry
  readonly renderSize: Size
}

export function createProcessingPlan(
  sourceSize: Size,
  state: ImageEditState,
  output: NormalizedOutputOptions,
): ProcessingPlan {
  const geometry = calculateImageGeometry(sourceSize, state)

  return {
    geometry,
    renderSize: output.preview
      ? limitPreviewSize(geometry.outputSize, {
          ...(output.maxPreviewDimension === undefined
            ? {}
            : { maxDimension: output.maxPreviewDimension }),
        })
      : geometry.outputSize,
  }
}

const ROTATIONS = new Set([0, 90, 180, 270])
const ASPECT_PRESETS = new Set([
  'free',
  'original',
  '1:1',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '16:9',
  '9:16',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

function validateState(value: unknown): value is ImageEditState {
  if (!isRecord(value)) {
    return false
  }
  const crop = value.crop
  if (
    !ROTATIONS.has(value.rotation as number) ||
    typeof value.flipHorizontal !== 'boolean' ||
    typeof value.flipVertical !== 'boolean' ||
    !isRecord(crop) ||
    !isFiniteNumber(crop.x) ||
    !isFiniteNumber(crop.y) ||
    !isPositiveNumber(crop.width) ||
    !isPositiveNumber(crop.height) ||
    !ASPECT_PRESETS.has(value.aspectRatio as string)
  ) {
    return false
  }

  if (value.zoom !== undefined && !isPositiveNumber(value.zoom)) {
    return false
  }
  if (value.panX !== undefined && !isFiniteNumber(value.panX)) {
    return false
  }
  if (value.panY !== undefined && !isFiniteNumber(value.panY)) {
    return false
  }

  if (value.resize !== undefined) {
    if (!isRecord(value.resize)) {
      return false
    }
    if (
      value.resize.width === undefined &&
      value.resize.height === undefined
    ) {
      return false
    }
    if (
      value.resize.width !== undefined &&
      !isPositiveNumber(value.resize.width)
    ) {
      return false
    }
    if (
      value.resize.height !== undefined &&
      !isPositiveNumber(value.resize.height)
    ) {
      return false
    }
  }

  return true
}

export function validateWorkerRequest(value: unknown): WorkerProcessRequest {
  if (!isRecord(value) || value.type !== 'process') {
    throw new Error('Worker request type is invalid.')
  }
  if (!Number.isInteger(value.requestId) || (value.requestId as number) < 1) {
    throw new Error('Worker request id is invalid.')
  }
  if (!Number.isInteger(value.generation) || (value.generation as number) < 0) {
    throw new Error('Worker request generation is invalid.')
  }
  if (typeof value.sourceKey !== 'string' || value.sourceKey.length === 0) {
    throw new Error('Worker source key is invalid.')
  }
  if (!validateState(value.state)) {
    throw new Error('Worker edit state is invalid.')
  }
  if (!isRecord(value.output) || !OUTPUT_MIME_TYPES.includes(value.output.mimeType as OutputMime)) {
    throw new Error('Worker output MIME type is invalid.')
  }
  if (typeof value.output.preview !== 'boolean') {
    throw new Error('Worker preview option is invalid.')
  }
  if (
    value.output.quality !== undefined &&
    (!isFiniteNumber(value.output.quality) || value.output.quality < 0.01 || value.output.quality > 1)
  ) {
    throw new Error('Worker quality option is invalid.')
  }
  if (
    value.output.maxPreviewDimension !== undefined &&
    (!isPositiveNumber(value.output.maxPreviewDimension) || !Number.isInteger(value.output.maxPreviewDimension))
  ) {
    throw new Error('Worker preview dimension option is invalid.')
  }

  if (value.source !== undefined) {
    if (!isRecord(value.source)) {
      throw new Error('Worker source pixels are invalid.')
    }
    if (!Number.isInteger(value.source.width) || !isPositiveNumber(value.source.width)) {
      throw new Error('Worker source width is invalid.')
    }
    if (!Number.isInteger(value.source.height) || !isPositiveNumber(value.source.height)) {
      throw new Error('Worker source height is invalid.')
    }
    if (!(value.source.data instanceof ArrayBuffer)) {
      throw new Error('Worker source pixel buffer is invalid.')
    }
    if (value.source.data.byteLength !== value.source.width * value.source.height * 4) {
      throw new Error('Worker source pixel buffer length is invalid.')
    }
  }

  return value as unknown as WorkerProcessRequest
}

export function validateWorkerClearRequest(value: unknown): WorkerClearRequest {
  if (!isRecord(value) || value.type !== 'clear') {
    throw new Error('Worker clear type is invalid.')
  }
  if (!Number.isInteger(value.generation) || (value.generation as number) < 1) {
    throw new Error('Worker clear generation is invalid.')
  }
  return value as unknown as WorkerClearRequest
}
