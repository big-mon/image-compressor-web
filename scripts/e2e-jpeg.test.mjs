import { describe, expect, it } from 'vitest'

import {
  createMetadataJpegFixture,
  detectMetadataFamilies,
  parseExifOrientation,
  parseJpegDimensions,
} from './e2e-jpeg.mjs'

describe('dependency-free JPEG E2E fixture helpers', () => {
  it('generates a valid representative JPEG with every injected metadata family', () => {
    const fixture = createMetadataJpegFixture()

    expect(fixture.slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]))
    expect(parseJpegDimensions(fixture)).toEqual({ width: 32, height: 16 })
    expect(parseExifOrientation(fixture)).toBe(6)
    expect(detectMetadataFamilies(fixture)).toEqual({
      comment: true,
      exif: true,
      gps: true,
      icc: true,
      xmp: true,
      iptc: true,
      photoshop: true,
    })
  })

  it('rejects malformed JPEGs instead of guessing dimensions', () => {
    expect(() => parseJpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow(/SOF/i)
  })
})
