import { describe, expect, it } from 'vitest'

import {
  calculateMetrics,
  getOutputExtension,
  assertSupportedImageMimeType,
  hasAnimatedWebpSignature,
  isSupportedImageMimeType,
  limitPreviewSize,
  normalizeOutputOptions,
  sanitizeDownloadFilename,
} from './raster'
import { createProcessingPlan, validateWorkerRequest } from './worker-protocol'
import { createEditState } from './geometry'

describe('raster output options', () => {
  it('normalizes MIME and clamps lossy quality', () => {
    expect(
      normalizeOutputOptions({ mimeType: 'image/jpeg', quality: 1.5 }),
    ).toEqual({ mimeType: 'image/jpeg', quality: 1, preview: false })
  })

  it('accepts only the three supported raster MIME types', () => {
    expect(isSupportedImageMimeType('image/jpeg')).toBe(true)
    expect(isSupportedImageMimeType('image/gif')).toBe(false)
    expect(() => assertSupportedImageMimeType('image/gif')).toThrow('JPEG、PNG、WebP')
  })

  it('detects the WebP animation feature bit', () => {
    const animatedHeader = new Uint8Array(24)
    animatedHeader.set([0x56, 0x50, 0x38, 0x58], 12)
    animatedHeader[20] = 0x02

    expect(hasAnimatedWebpSignature(animatedHeader)).toBe(true)
    expect(hasAnimatedWebpSignature(new Uint8Array(24))).toBe(false)
  })

  it('omits quality for PNG and uses a safe default for invalid lossy quality', () => {
    expect(
      normalizeOutputOptions({ mimeType: 'image/png', quality: 0.2 }),
    ).toEqual({ mimeType: 'image/png', preview: false })
    expect(
      normalizeOutputOptions({ mimeType: 'image/webp', quality: Number.NaN }),
    ).toEqual({ mimeType: 'image/webp', quality: 0.82, preview: false })
  })

  it('maps output MIME types to download extensions', () => {
    expect(getOutputExtension('image/jpeg')).toBe('jpg')
    expect(getOutputExtension('image/png')).toBe('png')
    expect(getOutputExtension('image/webp')).toBe('webp')
  })

  it('limits preview dimensions while preserving aspect ratio', () => {
    expect(limitPreviewSize({ width: 4000, height: 2000 }, { maxDimension: 1000 })).toEqual({
      width: 1000,
      height: 500,
    })
    expect(limitPreviewSize({ width: 400, height: 300 }, { maxDimension: 1000 })).toEqual({
      width: 400,
      height: 300,
    })
  })

  it('calculates byte reduction and allows output growth', () => {
    expect(
      calculateMetrics(
        { bytes: 100 },
        { width: 200, height: 150, bytes: 140 },
      ),
    ).toEqual({
      outputBytes: 140,
      reductionPercent: -40,
      outputWidth: 200,
      outputHeight: 150,
    })
  })

  it('sanitizes a source name and changes its extension', () => {
    expect(sanitizeDownloadFilename('holiday/photo?.JPG', 'image/webp')).toBe(
      'holiday-photo-edited.webp',
    )
    expect(sanitizeDownloadFilename('...', 'image/png')).toBe('image-edited.png')
  })

  it('validates worker requests without needing a Canvas implementation', () => {
    const request = {
      type: 'process',
      requestId: 1,
      generation: 0,
      sourceKey: 'source-1',
      source: {
        width: 4,
        height: 2,
        data: new ArrayBuffer(4 * 2 * 4),
      },
      state: createEditState({ width: 4, height: 2 }),
      output: { mimeType: 'image/png', preview: true },
    }

    expect(validateWorkerRequest(request)).toEqual(request)
    expect(() =>
      validateWorkerRequest({
        ...request,
        source: { ...request.source, data: new ArrayBuffer(1) },
      }),
    ).toThrow(/pixel buffer/i)
  })

  it('creates a preview plan from geometry and limits only its render dimensions', () => {
    const sourceSize = { width: 4000, height: 2000 }
    const state = createEditState(sourceSize)

    const plan = createProcessingPlan(
      sourceSize,
      state,
      { mimeType: 'image/webp', preview: true, quality: 0.8, maxPreviewDimension: 1000 },
    )

    expect(plan.geometry.outputSize).toEqual({ width: 4000, height: 2000 })
    expect(plan.renderSize).toEqual({ width: 1000, height: 500 })
  })
})
