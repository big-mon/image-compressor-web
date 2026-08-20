import type { Size } from './geometry'

export const OUTPUT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export type OutputMime = (typeof OUTPUT_MIME_TYPES)[number]

export interface RasterOutputOptions {
  readonly mimeType: OutputMime
  readonly quality?: number
  readonly preview?: boolean
  readonly maxPreviewDimension?: number
}

export interface NormalizedOutputOptions {
  readonly mimeType: OutputMime
  readonly quality?: number
  readonly preview: boolean
  readonly maxPreviewDimension?: number
}

export function normalizeOutputOptions(
  options: RasterOutputOptions,
): NormalizedOutputOptions {
  if (!OUTPUT_MIME_TYPES.includes(options.mimeType)) {
    throw new Error(`Unsupported output MIME type: ${options.mimeType}`)
  }

  const isLossy = options.mimeType === 'image/jpeg' || options.mimeType === 'image/webp'
  const requestedQuality = Number.isFinite(options.quality) ? options.quality : 0.82
  const quality = isLossy
    ? Math.min(Math.max(requestedQuality ?? 0.82, 0.01), 1)
    : undefined

  return {
    mimeType: options.mimeType,
    ...(quality === undefined ? {} : { quality }),
    preview: options.preview ?? false,
    ...(options.maxPreviewDimension === undefined
      ? {}
      : { maxPreviewDimension: options.maxPreviewDimension }),
  }
}

export function getOutputExtension(mimeType: OutputMime): 'jpg' | 'png' | 'webp' {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
  }
}

export interface ByteMetrics {
  readonly outputBytes: number
  readonly reductionPercent: number
}

export function calculateMetrics(
  source: { readonly bytes: number },
  output: { readonly width: number; readonly height: number; readonly bytes: number },
): ByteMetrics & {
  readonly outputWidth: number
  readonly outputHeight: number
} {
  const reductionBytes = source.bytes - output.bytes
  return {
    outputBytes: output.bytes,
    reductionPercent: source.bytes > 0 ? reductionBytes / source.bytes * 100 : 0,
    outputWidth: output.width,
    outputHeight: output.height,
  }
}

export function sanitizeDownloadFilename(sourceName: string, mimeType: OutputMime): string {
  const sourceStem = sourceName.replace(/\.[^./\\]+$/, '')
  const safeStem = sourceStem
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '')
  const stem = safeStem || 'image'

  return `${stem}-edited.${getOutputExtension(mimeType)}`
}

export interface PreviewSizeOptions {
  readonly maxDimension?: number
}

export function limitPreviewSize(size: Size, options: PreviewSizeOptions = {}): Size {
  const maxDimension = options.maxDimension ?? 1024
  if (maxDimension < 1 || !Number.isFinite(maxDimension)) {
    throw new Error('Preview max dimension must be a positive number.')
  }

  const largestDimension = Math.max(size.width, size.height)
  if (largestDimension <= maxDimension) {
    return { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) }
  }

  const scale = maxDimension / largestDimension
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

export interface DecodedSourcePixels {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

export interface RasterResult {
  readonly blob: Blob
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly mimeType: OutputMime
}
