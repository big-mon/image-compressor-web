import { describe, expect, it } from 'vitest'

import { stripEncodedMetadata } from './encoded-metadata'

const textEncoder = new TextEncoder()

function ascii(value: string): Uint8Array {
  return textEncoder.encode(value)
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function writeU16BE(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff])
}

function writeU32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function writeU32LE(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ])
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concatBytes(
    new Uint8Array([0xff, marker]),
    writeU16BE(payload.length + 2),
    payload,
  )
}

const JPEG_SOS_PAYLOAD = new Uint8Array([1, 1, 0, 0x00, 0x3f, 0])
const JPEG_SCAN = new Uint8Array([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9])

function createJpegFixture(): { readonly bytes: Uint8Array; readonly scan: Uint8Array } {
  const jfifPayload = new Uint8Array(14)
  jfifPayload.set(ascii('JFIF\0'))
  jfifPayload.set(new Uint8Array([1, 2, 1, 0, 72, 0, 72, 0, 0]), 5)

  const sofPayload = new Uint8Array([8, 0, 16, 0, 32, 1, 1, 0x11, 0])
  const dqtPayload = new Uint8Array(65)
  dqtPayload[0] = 0
  dqtPayload.fill(8, 1)
  const dhtPayload = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  const adobePayload = concatBytes(ascii('Adobe\0'), new Uint8Array([100, 0, 0, 0, 0, 0]))
  const metadata = [
    jpegSegment(0xe1, ascii('Exif\0\0GPS fixture')),
    jpegSegment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0XMP fixture')),
    jpegSegment(0xe2, ascii('ICC_PROFILE\0\x01\x01ICC fixture')),
    jpegSegment(0xed, ascii('Photoshop 3.0\0IPTC fixture')),
    jpegSegment(0xe3, ascii('private APP metadata')),
    jpegSegment(0xfe, ascii('JPEG comment fixture')),
  ]
  const scan = concatBytes(jpegSegment(0xda, JPEG_SOS_PAYLOAD), JPEG_SCAN)
  const bytes = concatBytes(
    new Uint8Array([0xff, 0xd8]),
    jpegSegment(0xe0, jfifPayload),
    ...metadata,
    jpegSegment(0xee, adobePayload),
    jpegSegment(0xdb, dqtPayload),
    jpegSegment(0xc4, dhtPayload),
    jpegSegment(0xc0, sofPayload),
    scan,
  )
  return { bytes, scan }
}

interface JpegHeaderSegment {
  readonly marker: number
  readonly bytes: Uint8Array
}

function readJpegHeader(input: Uint8Array): { readonly segments: readonly JpegHeaderSegment[]; readonly scan: Uint8Array } {
  expect(input.slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]))
  const segments: JpegHeaderSegment[] = []
  let offset = 2
  while (offset < input.length) {
    const markerStart = offset
    expect(input[offset]).toBe(0xff)
    offset += 1
    while (input[offset] === 0xff) {
      offset += 1
    }
    const marker = input[offset]
    if (marker === undefined) {
      throw new Error('JPEG marker is truncated.')
    }
    offset += 1
    if (marker === 0xda) {
      return { segments, scan: input.slice(markerStart) }
    }
    if (marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new Error('Unexpected JPEG marker in header.')
    }
    const length = ((input[offset] ?? 0) << 8) | (input[offset + 1] ?? 0)
    const end = offset + length
    if (length < 2 || end > input.length) {
      throw new Error('JPEG segment is truncated.')
    }
    segments.push({ marker, bytes: input.slice(markerStart, end) })
    offset = end
  }
  throw new Error('JPEG SOS is missing.')
}

function getPngChunkBytes(input: Uint8Array): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>()
  let offset = PNG_SIGNATURE.length
  while (offset < input.length) {
    const length = (
      (input[offset] ?? 0) * 0x1000000 +
      (input[offset + 1] ?? 0) * 0x10000 +
      (input[offset + 2] ?? 0) * 0x100 +
      (input[offset + 3] ?? 0)
    )
    const type = String.fromCharCode(...input.slice(offset + 4, offset + 8))
    const end = offset + 12 + length
    result.set(type, input.slice(offset, end))
    offset = end
  }
  return result
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return concatBytes(
    writeU32BE(data.length),
    ascii(type),
    data,
    new Uint8Array(4),
  )
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function createPngFixture(includeUnknownCritical = false): Uint8Array {
  const ihdr = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2, 8, 3, 0, 0, 0])
  const chunks = [
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', new Uint8Array([255, 0, 0, 0, 255, 0])),
    pngChunk('eXIf', ascii('EXIF fixture')),
    pngChunk('iCCP', ascii('ICC profile fixture')),
    pngChunk('tEXt', ascii('Comment\0fixture')),
    pngChunk('zTXt', ascii('Comment\0compressed fixture')),
    pngChunk('iTXt', ascii('Comment\0\0\0\0fixture')),
    pngChunk('tIME', new Uint8Array([7, 234, 8, 20, 12, 34, 56])),
    pngChunk('pHYs', new Uint8Array(9)),
    pngChunk('sRGB', new Uint8Array([0])),
    pngChunk('gAMA', new Uint8Array([0, 0, 0, 0])),
    pngChunk('cHRM', new Uint8Array(32)),
    pngChunk('bKGD', new Uint8Array([0, 1])),
    pngChunk('hIST', new Uint8Array([0, 1])),
    pngChunk('sPLT', ascii('palette')),
    pngChunk('oFFs', new Uint8Array(9)),
    pngChunk('pCAL', ascii('calibration')),
    pngChunk('sCAL', ascii('1\x01\x01')),
    pngChunk('sTER', new Uint8Array([0])),
    pngChunk('dSIG', ascii('signature')),
    ...(includeUnknownCritical ? [pngChunk('QXYZ', new Uint8Array([9, 8, 7]))] : []),
    pngChunk('tRNS', new Uint8Array([255, 128])),
    pngChunk('IDAT', new Uint8Array([1, 2, 3, 4])),
    pngChunk('IEND', new Uint8Array()),
  ]
  return concatBytes(PNG_SIGNATURE, ...chunks)
}

function getPngChunkTypes(input: Uint8Array): string[] {
  const result: string[] = []
  let offset = 8
  while (offset < input.length) {
    const length = (
      (input[offset] ?? 0) * 0x1000000 +
      (input[offset + 1] ?? 0) * 0x10000 +
      (input[offset + 2] ?? 0) * 0x100 +
      (input[offset + 3] ?? 0)
    )
    const type = String.fromCharCode(...input.slice(offset + 4, offset + 8))
    result.push(type)
    offset += 12 + length
  }
  return result
}

function webpChunk(type: string, payload: Uint8Array): Uint8Array {
  return concatBytes(
    ascii(type),
    writeU32LE(payload.length),
    payload,
    payload.length % 2 === 0 ? new Uint8Array() : new Uint8Array([0]),
  )
}

function createWebpFixture(): Uint8Array {
  const vp8xPayload = new Uint8Array([0x3e, 0, 0, 0, 0, 1, 0, 0, 1, 0])
  const chunks = [
    webpChunk('VP8X', vp8xPayload),
    webpChunk('ICCP', ascii('ICC profile')),
    webpChunk('EXIF', ascii('EXIF fixture')),
    webpChunk('XMP ', ascii('XMP fixture')),
    webpChunk('ALPH', new Uint8Array([1, 2, 3])),
    webpChunk('VP8 ', new Uint8Array([4, 5, 6, 7])),
  ]
  const body = concatBytes(...chunks)
  return concatBytes(ascii('RIFF'), writeU32LE(body.length + 4), ascii('WEBP'), body)
}

function getWebpChunks(input: Uint8Array): Array<{ readonly type: string; readonly payload: Uint8Array }> {
  const result: Array<{ readonly type: string; readonly payload: Uint8Array }> = []
  let offset = 12
  while (offset < input.length) {
    const type = String.fromCharCode(...input.slice(offset, offset + 4))
    const size = (input[offset + 4] ?? 0) |
      ((input[offset + 5] ?? 0) << 8) |
      ((input[offset + 6] ?? 0) << 16) |
      ((input[offset + 7] ?? 0) << 24)
    result.push({ type, payload: input.slice(offset + 8, offset + 8 + size) })
    offset += 8 + size + (size % 2)
  }
  return result
}

describe('stripEncodedMetadata', () => {
  describe('JPEG', () => {
    it('removes every injected metadata family while preserving structural segments and the scan', () => {
      const fixture = createJpegFixture()
      const output = stripEncodedMetadata(fixture.bytes, 'image/jpeg')
      const parsed = readJpegHeader(output)
      const markers = parsed.segments.map((segment) => segment.marker)
      const inputSegments = readJpegHeader(fixture.bytes).segments

      expect(markers).toEqual([0xe0, 0xee, 0xdb, 0xc4, 0xc0])
      expect(parsed.scan).toEqual(fixture.scan)
      for (const marker of [0xe0, 0xee, 0xdb, 0xc4, 0xc0]) {
        expect(parsed.segments.find((segment) => segment.marker === marker)?.bytes).toEqual(
          inputSegments.find((segment) => segment.marker === marker)?.bytes,
        )
      }
      expect(output).not.toEqual(fixture.bytes)
      expect(fixture.bytes.slice(-fixture.scan.length)).toEqual(fixture.scan)
    })

    it('fails closed for missing SOI, truncated segments, and missing EOI', () => {
      expect(() => stripEncodedMetadata(new Uint8Array([0, 1, 2]), 'image/jpeg')).toThrow(/JPEG/i)
      expect(() => stripEncodedMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 20]), 'image/jpeg')).toThrow(/JPEG/i)
      expect(() => stripEncodedMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 1]), 'image/jpeg')).toThrow(/JPEG/i)

      const fixture = createJpegFixture()
      expect(() => stripEncodedMetadata(fixture.bytes.slice(0, -1), 'image/jpeg')).toThrow(/JPEG/i)
    })
  })

  describe('PNG', () => {
    it('removes metadata chunks but preserves pixel-critical chunks byte-for-byte', () => {
      const fixture = createPngFixture()
      const output = stripEncodedMetadata(fixture, 'image/png')
      const inputChunks = getPngChunkBytes(fixture)
      const outputChunks = getPngChunkBytes(output)

      expect(getPngChunkTypes(output)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])
      expect(output.slice(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE)
      for (const type of ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']) {
        expect(outputChunks.get(type)).toEqual(inputChunks.get(type))
      }
    })

    it('keeps an unknown critical chunk because it may be required for decoding', () => {
      const output = stripEncodedMetadata(createPngFixture(true), 'image/png')

      expect(getPngChunkTypes(output)).toContain('QXYZ')
      expect(getPngChunkTypes(output)).not.toContain('eXIf')
    })

    it('fails closed for invalid signatures, chunk bounds, and missing IEND', () => {
      const fixture = createPngFixture()
      const invalidSignature = fixture.slice()
      invalidSignature[0] = 0
      expect(() => stripEncodedMetadata(invalidSignature, 'image/png')).toThrow(/PNG/i)

      const truncatedChunk = fixture.slice(0, fixture.length - 2)
      expect(() => stripEncodedMetadata(truncatedChunk, 'image/png')).toThrow(/PNG/i)

      const invalidLength = fixture.slice()
      invalidLength[8] = 0xff
      invalidLength[9] = 0xff
      invalidLength[10] = 0xff
      invalidLength[11] = 0xff
      expect(() => stripEncodedMetadata(invalidLength, 'image/png')).toThrow(/PNG/i)

      const withoutIend = fixture.slice(0, -12)
      expect(() => stripEncodedMetadata(withoutIend, 'image/png')).toThrow(/PNG/i)
    })
  })

  describe('WebP', () => {
    it('removes metadata, updates RIFF size, and clears only metadata feature bits', () => {
      const fixture = createWebpFixture()
      const output = stripEncodedMetadata(fixture, 'image/webp')
      const chunks = getWebpChunks(output)
      const vp8x = chunks.find((chunk) => chunk.type === 'VP8X')

      expect(output.slice(0, 4)).toEqual(ascii('RIFF'))
      expect(output.slice(8, 12)).toEqual(ascii('WEBP'))
      expect(output.slice(4, 8)).toEqual(writeU32LE(output.length - 8))
      expect(chunks.map((chunk) => chunk.type)).toEqual(['VP8X', 'ALPH', 'VP8 '])
      expect(vp8x?.payload[0]).toBe(0x12)
      expect(chunks.find((chunk) => chunk.type === 'ALPH')?.payload).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('fails closed for invalid RIFF bounds, truncated chunks, and malformed VP8X', () => {
      const fixture = createWebpFixture()
      const invalidHeader = fixture.slice()
      invalidHeader[0] = 0
      expect(() => stripEncodedMetadata(invalidHeader, 'image/webp')).toThrow(/WebP/i)

      const invalidSize = fixture.slice()
      invalidSize[4] = (invalidSize[4] ?? 0) + 1
      expect(() => stripEncodedMetadata(invalidSize, 'image/webp')).toThrow(/WebP/i)

      expect(() => stripEncodedMetadata(fixture.slice(0, -1), 'image/webp')).toThrow(/WebP/i)

      const malformedVp8xBody = webpChunk('VP8X', new Uint8Array(9))
      const body = concatBytes(malformedVp8xBody)
      const malformedVp8x = concatBytes(ascii('RIFF'), writeU32LE(body.length + 4), ascii('WEBP'), body)
      expect(() => stripEncodedMetadata(malformedVp8x, 'image/webp')).toThrow(/WebP/i)
    })
  })

  it('rejects unsupported MIME types instead of returning bytes unchanged', () => {
    expect(() => stripEncodedMetadata(new Uint8Array(), 'image/gif')).toThrow(/MIME/i)
  })
})
