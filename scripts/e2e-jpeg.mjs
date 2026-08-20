// Self-contained 32x16 stored JPEG with asymmetric colorful quadrants and landmarks.
const BASE_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAEAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAEAAgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAQEBAQEBAgEBAgICAgICAwICAgIDBAMDAwMDBAUEBAQEBAQFBQUFBQUFBQYGBgYGBgcHBwcHCAgICAgICAgICP/bAEMBAQEBAgICAwICAwgFBQUICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICP/dAAQAAv/aAAwDAQACEQMRAD8A+Q/+Eo/6Yf8Aj/8A9auy+HP7RPg34S+DbP4ffD/wd/Z+kaf5v2S0/taWfy/PleeT95PFJIcySM3zMcZwMAAD9Yv+GCP+pr/8pf8A91V8p/8ACxf+nP8A8jf/AGFcnBnj34e+ISrLwK4e9r9W5frX+0V429pzew/3yEL35K38O9vt2vG/754k+LPhlxdRo4b6anCTcKTcsuj9dxKi5NWxbaylRTaX1dJ4i7SlJUbXq3+wfgf+2J8L/wBnD4X6X8GPgx8Nf7G8NaN9p/s3Tf8AhIbi78n7XcSXc3767t5pm3TTO3zOcZwMKAB+V3/Cuv8Ap8/8g/8A2dRfEb/gk78OPhL9j/4WB8Yf7P8A7Q837J/xSk8/meRs8z/UX0mMeYv3sZzxnBriP+IgP/qkn/l0f/eur+jLkGbeEGMzuSy//WOtj3SlVviI4SdCVP2srzvKtKo6/tm7vla9m373Pp+DfSZwfAni1luQYzFYCfDWGwyrKhNwxOKpYpSdOE1Sly0YxWHdJRkoOetRJ8vLZ//Z'

const EXIF_PREFIX = new TextEncoder().encode('Exif\0\0')
const ICC_PROFILE_PREFIX = new TextEncoder().encode('ICC_PROFILE\0')
const XMP_PREFIX = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0')
const PHOTOSHOP_PREFIX = new TextEncoder().encode('Photoshop 3.0\0')
const PHOTOSHOP_RESOURCE_SIGNATURE = new TextEncoder().encode('8BIM')

function asBytes(value) {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  throw new TypeError('Expected JPEG bytes as Uint8Array or ArrayBuffer.')
}

function ascii(value) {
  return new TextEncoder().encode(value)
}

function concatBytes(...parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function startsWithBytes(value, prefix) {
  return prefix.every((byte, index) => value[index] === byte)
}

function createAppSegment(marker, payload) {
  const length = payload.length + 2
  if (length > 0xffff) {
    throw new Error('JPEG APP segment is too large.')
  }
  return concatBytes(
    new Uint8Array([0xff, marker, (length >> 8) & 0xff, length & 0xff]),
    payload,
  )
}

function createExifPayload() {
  const model = ascii('Codex Camera\0')
  const tiffLength = 182
  const tiff = new Uint8Array(tiffLength)
  const view = new DataView(tiff.buffer)
  const writeAscii = (offset, value) => tiff.set(value, offset)
  const writeU16 = (offset, value) => view.setUint16(offset, value, true)
  const writeU32 = (offset, value) => view.setUint32(offset, value, true)

  writeAscii(0, new Uint8Array([0x49, 0x49]))
  writeU16(2, 0x2a)
  writeU32(4, 8)

  writeU16(8, 3)
  writeU16(10, 0x0112)
  writeU16(12, 3)
  writeU32(14, 1)
  writeU16(18, 6)
  writeU16(20, 0)
  writeU16(22, 0x0110)
  writeU16(24, 2)
  writeU32(26, model.length)
  writeU32(30, 48)
  writeU16(34, 0x8825)
  writeU16(36, 4)
  writeU32(38, 1)
  writeU32(42, 64)
  writeU32(46, 0)
  writeAscii(48, model)

  writeU16(64, 5)
  writeU16(66, 0x0000)
  writeU16(68, 1)
  writeU32(70, 4)
  writeAscii(74, new Uint8Array([2, 3, 0, 0]))
  writeU16(78, 0x0001)
  writeU16(80, 2)
  writeU32(82, 2)
  writeU32(86, 130)
  writeU16(90, 0x0002)
  writeU16(92, 5)
  writeU32(94, 3)
  writeU32(98, 132)
  writeU16(102, 0x0003)
  writeU16(104, 2)
  writeU32(106, 2)
  writeU32(110, 156)
  writeU16(114, 0x0004)
  writeU16(116, 5)
  writeU32(118, 3)
  writeU32(122, 158)
  writeU32(126, 0)

  writeAscii(130, ascii('N\0'))
  writeU32(132, 35)
  writeU32(136, 1)
  writeU32(140, 41)
  writeU32(144, 1)
  writeU32(148, 30)
  writeU32(152, 1)
  writeAscii(156, ascii('E\0'))
  writeU32(158, 139)
  writeU32(162, 1)
  writeU32(166, 41)
  writeU32(170, 1)
  writeU32(174, 0)
  writeU32(178, 1)

  return concatBytes(EXIF_PREFIX, tiff)
}

function createXmpPayload() {
  return concatBytes(
    XMP_PREFIX,
    ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Codex E2E"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" exif:GPSLatitude="35,41,30N" dc:creator="Codex E2E fixture"/></rdf:RDF></x:xmpmeta>'),
  )
}

function createIccPayload() {
  return concatBytes(
    ICC_PROFILE_PREFIX,
    new Uint8Array([1, 1]),
    ascii('Codex ICC profile fixture'),
  )
}

function createPhotoshopResource(resourceId, data) {
  const name = new Uint8Array([0])
  const paddedName = name.length % 2 === 0 ? name : concatBytes(name, new Uint8Array([0]))
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, data.length, false)
  const resourceIdBytes = new Uint8Array(2)
  new DataView(resourceIdBytes.buffer).setUint16(0, resourceId, false)
  const padding = data.length % 2 === 0 ? new Uint8Array() : new Uint8Array([0])

  return concatBytes(
    PHOTOSHOP_RESOURCE_SIGNATURE,
    resourceIdBytes,
    paddedName,
    size,
    data,
    padding,
  )
}

function createPhotoshopPayload() {
  const iptcData = concatBytes(
    new Uint8Array([0x1c, 0x02, 0x05, 0x00, 0x0d]),
    ascii('Codex E2E IPTC'),
  )
  const photoshopData = ascii('Codex Photoshop resource')
  return concatBytes(
    PHOTOSHOP_PREFIX,
    createPhotoshopResource(0x0404, iptcData),
    createPhotoshopResource(0x040f, photoshopData),
  )
}

export function createMetadataJpegFixture() {
  const base = Uint8Array.from(Buffer.from(BASE_JPEG_BASE64, 'base64'))
  if (base[0] !== 0xff || base[1] !== 0xd8) {
    throw new Error('The embedded JPEG baseline is invalid.')
  }

  return concatBytes(
    base.slice(0, 2),
    createAppSegment(0xe1, createExifPayload()),
    createAppSegment(0xe1, createXmpPayload()),
    createAppSegment(0xe2, createIccPayload()),
    createAppSegment(0xed, createPhotoshopPayload()),
    createAppSegment(0xfe, ascii('Codex JPEG comment fixture')),
    base.slice(2),
  )
}

export function parseJpegSegments(input) {
  const bytes = asBytes(input)
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('JPEG SOI marker is missing.')
  }

  const segments = []
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error('JPEG marker prefix is invalid.')
    }
    while (bytes[offset] === 0xff) {
      offset += 1
    }
    const marker = bytes[offset]
    offset += 1
    if (marker === undefined) {
      throw new Error('JPEG marker is truncated.')
    }
    if (marker === 0xd9) {
      break
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue
    }
    if (offset + 2 > bytes.length) {
      throw new Error('JPEG segment length is truncated.')
    }
    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) {
      throw new Error('JPEG segment length is invalid.')
    }
    const payload = bytes.slice(offset + 2, offset + length)
    segments.push({ marker, payload })
    offset += length
    if (marker === 0xda) {
      break
    }
  }
  return segments
}

export function parseJpegDimensions(input) {
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ])
  for (const segment of parseJpegSegments(input)) {
    if (!sofMarkers.has(segment.marker)) {
      continue
    }
    if (segment.payload.length < 5) {
      throw new Error('JPEG SOF segment is truncated.')
    }
    const height = (segment.payload[1] << 8) | segment.payload[2]
    const width = (segment.payload[3] << 8) | segment.payload[4]
    if (width < 1 || height < 1) {
      throw new Error('JPEG SOF dimensions are invalid.')
    }
    return { width, height }
  }
  throw new Error('JPEG SOF dimensions were not found.')
}

function readExifOrientation(payload) {
  if (!startsWithBytes(payload, EXIF_PREFIX) || payload.length < EXIF_PREFIX.length + 14) {
    return undefined
  }
  const tiff = payload.slice(EXIF_PREFIX.length)
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const littleEndian = tiff[0] === 0x49 && tiff[1] === 0x49
  const bigEndian = tiff[0] === 0x4d && tiff[1] === 0x4d
  if ((!littleEndian && !bigEndian) || view.getUint16(2, littleEndian) !== 0x2a) {
    return undefined
  }
  const readU16 = (offset) => view.getUint16(offset, littleEndian)
  const readU32 = (offset) => view.getUint32(offset, littleEndian)
  const ifdOffset = readU32(4)
  if (ifdOffset + 2 > tiff.length) {
    return undefined
  }
  const entryCount = readU16(ifdOffset)
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12
    if (entryOffset + 12 > tiff.length) {
      return undefined
    }
    if (readU16(entryOffset) !== 0x0112) {
      continue
    }
    const type = readU16(entryOffset + 2)
    const count = readU32(entryOffset + 4)
    if (type !== 3 || count < 1) {
      return undefined
    }
    const valueOffset = count === 1 ? entryOffset + 8 : readU32(entryOffset + 8)
    if (valueOffset + 2 > tiff.length) {
      return undefined
    }
    return readU16(valueOffset)
  }
  return undefined
}

export function parseExifOrientation(input) {
  for (const segment of parseJpegSegments(input)) {
    if (segment.marker !== 0xe1) {
      continue
    }
    const orientation = readExifOrientation(segment.payload)
    if (orientation !== undefined) {
      return orientation
    }
  }
  return undefined
}

function hasGpsIfd(payload) {
  if (!startsWithBytes(payload, EXIF_PREFIX) || payload.length < EXIF_PREFIX.length + 14) {
    return false
  }
  const tiff = payload.slice(EXIF_PREFIX.length)
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const littleEndian = tiff[0] === 0x49 && tiff[1] === 0x49
  if ((!littleEndian && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) || view.getUint16(2, littleEndian) !== 0x2a) {
    return false
  }
  const readU16 = (offset) => view.getUint16(offset, littleEndian)
  const readU32 = (offset) => view.getUint32(offset, littleEndian)
  const ifdOffset = readU32(4)
  if (ifdOffset + 2 > tiff.length) {
    return false
  }
  const entryCount = readU16(ifdOffset)
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12
    if (entryOffset + 12 > tiff.length) {
      return false
    }
    if (readU16(entryOffset) !== 0x8825) {
      continue
    }
    const gpsOffset = readU32(entryOffset + 8)
    if (gpsOffset + 2 > tiff.length) {
      return false
    }
    const gpsEntryCount = readU16(gpsOffset)
    for (let gpsIndex = 0; gpsIndex < gpsEntryCount; gpsIndex += 1) {
      const gpsEntryOffset = gpsOffset + 2 + gpsIndex * 12
      if (gpsEntryOffset + 12 > tiff.length) {
        return false
      }
      const tag = readU16(gpsEntryOffset)
      if (tag === 0x0001 || tag === 0x0002 || tag === 0x0003 || tag === 0x0004) {
        return true
      }
    }
  }
  return false
}

function hasIptcResource(payload) {
  if (!startsWithBytes(payload, PHOTOSHOP_PREFIX)) {
    return false
  }
  let offset = PHOTOSHOP_PREFIX.length
  while (offset + 12 <= payload.length) {
    if (!startsWithBytes(payload.slice(offset, offset + 4), PHOTOSHOP_RESOURCE_SIGNATURE)) {
      return false
    }
    const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset)
    const resourceId = view.getUint16(4, false)
    const nameLength = payload[offset + 6]
    if (nameLength === undefined) {
      return false
    }
    const nameFieldLength = (1 + nameLength + 1) & ~1
    const sizeOffset = 6 + nameFieldLength
    const dataSize = view.getUint32(sizeOffset, false)
    const dataOffset = sizeOffset + 4
    const dataEnd = dataOffset + dataSize
    if (dataEnd > payload.length - offset) {
      return false
    }
    if (resourceId === 0x0404) {
      const data = payload.slice(offset + dataOffset, offset + dataEnd)
      if (data[0] === 0x1c && data[1] === 0x02) {
        return true
      }
    }
    offset += dataEnd + (dataSize % 2)
  }
  return false
}

function hasIccProfile(payload) {
  if (!startsWithBytes(payload, ICC_PROFILE_PREFIX)) {
    return false
  }
  const sequenceNumber = payload[ICC_PROFILE_PREFIX.length]
  const sequenceCount = payload[ICC_PROFILE_PREFIX.length + 1]
  return sequenceNumber !== undefined && sequenceCount !== undefined && sequenceNumber > 0 && sequenceNumber <= sequenceCount && payload.length > ICC_PROFILE_PREFIX.length + 2
}

export function detectMetadataFamilies(input) {
  const result = {
    comment: false,
    exif: false,
    gps: false,
    icc: false,
    xmp: false,
    iptc: false,
    photoshop: false,
  }
  for (const segment of parseJpegSegments(input)) {
    if (segment.marker === 0xe1) {
      if (startsWithBytes(segment.payload, EXIF_PREFIX)) {
        result.exif = true
        result.gps ||= hasGpsIfd(segment.payload)
      }
      if (startsWithBytes(segment.payload, XMP_PREFIX)) {
        result.xmp = true
      }
    }
    if (segment.marker === 0xe2 && hasIccProfile(segment.payload)) {
      result.icc = true
    }
    if (segment.marker === 0xed && startsWithBytes(segment.payload, PHOTOSHOP_PREFIX)) {
      result.photoshop = true
      result.iptc ||= hasIptcResource(segment.payload)
    }
    if (segment.marker === 0xfe && segment.payload.length > 0) {
      result.comment = true
    }
  }
  return result
}
