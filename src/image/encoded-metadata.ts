type EncodedBytes = Uint8Array | ArrayBuffer

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
])

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_METADATA_CHUNKS = new Set([
  'eXIf',
  'iCCP',
  'tEXt',
  'zTXt',
  'iTXt',
  'tIME',
  'pHYs',
  'sRGB',
  'gAMA',
  'cHRM',
  'bKGD',
  'hIST',
  'sPLT',
  'oFFs',
  'pCAL',
  'sCAL',
  'sTER',
  'dSIG',
  'iDOT',
  'acTL',
  'fcTL',
  'fdAT',
])
const WEBP_METADATA_CHUNKS = new Set(['ICCP', 'EXIF', 'XMP '])
const ASCII_JFIF = new TextEncoder().encode('JFIF\0')
const ASCII_ADOBE = new TextEncoder().encode('Adobe')

function fail(format: string, message: string): never {
  throw new Error(`${format} ${message}`)
}

function asBytes(input: EncodedBytes): Uint8Array {
  if (input instanceof Uint8Array) {
    return input
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input)
  }
  throw new TypeError('Encoded image bytes must be a Uint8Array or ArrayBuffer.')
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function startsWithBytes(input: Uint8Array, prefix: Uint8Array): boolean {
  if (input.length < prefix.length) {
    return false
  }
  return prefix.every((byte, index) => input[index] === byte)
}

function readU16BE(bytes: Uint8Array, offset: number, format: string): number {
  const high = bytes[offset]
  const low = bytes[offset + 1]
  if (high === undefined || low === undefined) {
    fail(format, 'segment length is truncated.')
  }
  return (high << 8) | low
}

function readU32BE(bytes: Uint8Array, offset: number, format: string): number {
  const first = bytes[offset]
  const second = bytes[offset + 1]
  const third = bytes[offset + 2]
  const fourth = bytes[offset + 3]
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    fail(format, 'chunk length is truncated.')
  }
  return first * 0x1000000 + second * 0x10000 + third * 0x100 + fourth
}

function readU32LE(bytes: Uint8Array, offset: number, format: string): number {
  const first = bytes[offset]
  const second = bytes[offset + 1]
  const third = bytes[offset + 2]
  const fourth = bytes[offset + 3]
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    fail(format, 'RIFF size is truncated.')
  }
  return first + second * 0x100 + third * 0x10000 + fourth * 0x1000000
}

function writeU32LE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('WebP RIFF size is out of range.')
  }
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ])
}

function readFourCc(bytes: Uint8Array, offset: number, format: string): string {
  if (offset + 4 > bytes.length) {
    fail(format, 'chunk type is truncated.')
  }
  const characters: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[offset + index]
    if (byte === undefined || byte < 0x20 || byte > 0x7e) {
      fail(format, 'chunk type is invalid.')
    }
    characters.push(String.fromCharCode(byte))
  }
  return characters.join('')
}

function readJpegSegmentEnd(bytes: Uint8Array, lengthOffset: number): number {
  const length = readU16BE(bytes, lengthOffset, 'JPEG')
  if (length < 2) {
    fail('JPEG', 'segment length is invalid.')
  }
  const end = lengthOffset + length
  if (end > bytes.length) {
    fail('JPEG', 'segment length exceeds the encoded bytes.')
  }
  return end
}

function isJpegAppMarker(marker: number): boolean {
  return marker >= 0xe0 && marker <= 0xef
}

function shouldKeepJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xfe || isJpegAppMarker(marker)) {
    // APP0/JFIF is retained because it describes the JPEG container. Adobe
    // APP14 is retained because its transform value can be required to decode
    // the color transform. Every other APPn and COM is encoded metadata.
    return (marker === 0xe0 && startsWithBytes(payload, ASCII_JFIF)) ||
      (marker === 0xee && startsWithBytes(payload, ASCII_ADOBE))
  }
  return true
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    fail('JPEG', 'SOI marker is missing.')
  }

  const retained: Uint8Array[] = [bytes.slice(0, 2)]
  let offset = 2
  let sawSof = false

  while (offset < bytes.length) {
    const markerStart = offset
    if (bytes[offset] !== 0xff) {
      fail('JPEG', 'marker prefix is invalid before SOS.')
    }
    offset += 1
    while (bytes[offset] === 0xff) {
      offset += 1
    }
    const marker = bytes[offset]
    if (marker === undefined) {
      fail('JPEG', 'marker is truncated.')
    }
    offset += 1

    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd9) {
      fail('JPEG', 'unexpected standalone marker before SOS.')
    }
    if (marker === 0xda) {
      const segmentEnd = readJpegSegmentEnd(bytes, offset)
      const segmentLength = segmentEnd - offset
      if (segmentLength < 8) {
        fail('JPEG', 'SOS segment length is invalid.')
      }
      if (!sawSof) {
        fail('JPEG', 'SOF segment is missing before SOS.')
      }
      if (bytes.length < 2 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
        fail('JPEG', 'EOI marker is missing at the end of the scan.')
      }
      // The entropy-coded scan and every marker after the first SOS are copied
      // byte-for-byte. This avoids interpreting stuffed bytes as metadata.
      retained.push(bytes.slice(markerStart))
      return concatBytes(retained)
    }

    if (marker === 0x01) {
      retained.push(bytes.slice(markerStart, offset))
      continue
    }

    const segmentEnd = readJpegSegmentEnd(bytes, offset)
    const payload = bytes.slice(offset + 2, segmentEnd)
    if (JPEG_SOF_MARKERS.has(marker)) {
      sawSof = true
    }
    if (shouldKeepJpegSegment(marker, payload)) {
      retained.push(bytes.slice(markerStart, segmentEnd))
    }
    offset = segmentEnd
  }

  fail('JPEG', 'SOS segment is missing.')
}

function matchesBytes(bytes: Uint8Array, expected: Uint8Array): boolean {
  return bytes.length === expected.length && expected.every((byte, index) => bytes[index] === byte)
}

function isUppercaseAscii(byte: number): boolean {
  return byte >= 0x41 && byte <= 0x5a
}

function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (!matchesBytes(bytes.slice(0, PNG_SIGNATURE.length), PNG_SIGNATURE)) {
    fail('PNG', 'signature is invalid.')
  }

  const retained: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE.length)]
  let offset = PNG_SIGNATURE.length
  let sawIhdr = false
  let sawIdat = false

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      fail('PNG', 'chunk header or CRC is truncated.')
    }
    const length = readU32BE(bytes, offset, 'PNG')
    const type = readFourCc(bytes, offset + 4, 'PNG')
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) {
      fail('PNG', 'chunk length exceeds the encoded bytes.')
    }
    const chunk = bytes.slice(offset, chunkEnd)

    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) {
        fail('PNG', 'IHDR must be the first chunk and contain 13 bytes.')
      }
      sawIhdr = true
    } else if (type === 'IHDR') {
      fail('PNG', 'duplicate IHDR chunk is invalid.')
    }

    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || chunkEnd !== bytes.length) {
        fail('PNG', 'IEND is malformed or is not the final chunk.')
      }
      retained.push(chunk)
      return concatBytes(retained)
    }

    if (type === 'IDAT') {
      sawIdat = true
      retained.push(chunk)
    } else if (type === 'tRNS') {
      // Transparency is part of the decoded raster and must survive stripping.
      retained.push(chunk)
    } else if (!PNG_METADATA_CHUNKS.has(type) && isUppercaseAscii(type.charCodeAt(0))) {
      // An unknown critical chunk may affect decoding. Preserve it rather than
      // guessing that it is metadata; unknown ancillary chunks are removed.
      retained.push(chunk)
    } else if (type === 'IHDR' || type === 'PLTE') {
      retained.push(chunk)
    }

    offset = chunkEnd
  }

  fail('PNG', 'IEND chunk is missing.')
}

function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12 ||
    !matchesBytes(bytes.slice(0, 4), new TextEncoder().encode('RIFF')) ||
    !matchesBytes(bytes.slice(8, 12), new TextEncoder().encode('WEBP'))) {
    fail('WebP', 'RIFF/WEBP header is invalid.')
  }

  const declaredRiffSize = readU32LE(bytes, 4, 'WebP')
  if (declaredRiffSize !== bytes.length - 8) {
    fail('WebP', 'RIFF size does not match the encoded bytes.')
  }

  const retainedChunks: Uint8Array[] = []
  let offset = 12
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      fail('WebP', 'chunk header is truncated.')
    }
    const type = readFourCc(bytes, offset, 'WebP')
    const payloadLength = readU32LE(bytes, offset + 4, 'WebP')
    const payloadStart = offset + 8
    const payloadEnd = payloadStart + payloadLength
    const chunkEnd = payloadEnd + (payloadLength % 2)
    if (payloadEnd < payloadStart || chunkEnd > bytes.length) {
      fail('WebP', 'chunk length or padding exceeds the encoded bytes.')
    }
    if (payloadLength % 2 === 1 && bytes[payloadEnd] !== 0) {
      fail('WebP', 'chunk padding is invalid.')
    }

    if (!WEBP_METADATA_CHUNKS.has(type)) {
      const chunk = bytes.slice(offset, chunkEnd)
      if (type === 'VP8X') {
        if (payloadLength !== 10) {
          fail('WebP', 'VP8X payload length is invalid.')
        }
        chunk[8] = (chunk[8] ?? 0) & ~(0x20 | 0x08 | 0x04)
      }
      retainedChunks.push(chunk)
    }
    offset = chunkEnd
  }

  if (offset !== bytes.length) {
    fail('WebP', 'chunk parsing did not consume the RIFF payload.')
  }
  const body = concatBytes(retainedChunks)
  return concatBytes([
    new TextEncoder().encode('RIFF'),
    writeU32LE(body.length + 4),
    new TextEncoder().encode('WEBP'),
    body,
  ])
}

export function stripEncodedMetadata(bytes: EncodedBytes, mimeType: string): Uint8Array {
  const input = asBytes(bytes)
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return stripJpegMetadata(input)
    case 'image/png':
      return stripPngMetadata(input)
    case 'image/webp':
      return stripWebpMetadata(input)
    default:
      throw new Error(`Unsupported encoded image MIME type: ${mimeType}`)
  }
}
