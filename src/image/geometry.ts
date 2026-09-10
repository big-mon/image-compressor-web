export interface Size {
  readonly width: number
  readonly height: number
}

/** The complete rotated image bounds; imageSize/angle describe its occupied polygon. */
export interface CropBounds extends Size {
  readonly imageSize?: Size
  readonly angle?: number
}

/** A crop rectangle is always expressed in final displayed-orientation pixels. */
export interface CropRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type Rotation = 0 | 90 | 180 | 270

export type AspectRatioPreset =
  | 'free'
  | 'original'
  | '1:1'
  | '4:3'
  | '3:4'
  | '3:2'
  | '2:3'
  | '16:9'
  | '9:16'

export interface ResizeOptions {
  readonly width?: number
  readonly height?: number
}

export interface ImageEditState {
  readonly rotation: Rotation
  /** Fine rotation in degrees, before final-axis flips; omitted means zero. */
  readonly straighten?: number
  readonly flipHorizontal: boolean
  readonly flipVertical: boolean
  readonly crop: CropRect
  readonly aspectRatio: AspectRatioPreset
  /** Normalized crop framing controls. Values outside their useful range are clamped. */
  readonly zoom?: number
  readonly panX?: number
  readonly panY?: number
  readonly resize?: ResizeOptions
}

export interface ImageGeometry {
  readonly displaySize: CropBounds
  readonly straightening: { readonly degrees: number; readonly scale: number }
  readonly crop: CropRect
  readonly sourceCrop: CropRect
  readonly croppedSize: Size
  readonly outputSize: Size
  readonly transformOrder: readonly [
    'normalize-source-orientation',
    'rotate-flip',
    'crop-final-display',
    'resize',
  ]
}

const TRANSFORM_ORDER: ImageGeometry['transformOrder'] = [
  'normalize-source-orientation',
  'rotate-flip',
  'crop-final-display',
  'resize',
]

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function roundDimension(value: number): number {
  return Math.max(1, Math.round(value))
}

function getAspectRatio(
  preset: Exclude<AspectRatioPreset, 'free'>,
  displaySize: CropBounds,
): number {
  switch (preset) {
    case 'original':
      return (displaySize.imageSize ?? displaySize).width / (displaySize.imageSize ?? displaySize).height
    case '1:1':
      return 1
    case '4:3':
      return 4 / 3
    case '3:4':
      return 3 / 4
    case '3:2':
      return 3 / 2
    case '2:3':
      return 2 / 3
    case '16:9':
      return 16 / 9
    case '9:16':
      return 9 / 16
    default:
      throw new Error(`Aspect ratio preset is not implemented: ${preset}`)
  }
}

function clampCropToBounds(crop: CropRect, displaySize: CropBounds): CropRect {
  const width = clamp(crop.width, 1, displaySize.width)
  const height = clamp(crop.height, 1, displaySize.height)

  return {
    x: clamp(crop.x, 0, displaySize.width - width),
    y: clamp(crop.y, 0, displaySize.height - height),
    width,
    height,
  }
}

function interpolatePanOrigin(neutralOrigin: number, maximumTravel: number, pan: number): number {
  const targetOrigin = pan < 0 ? 0 : maximumTravel
  return neutralOrigin + (targetOrigin - neutralOrigin) * Math.abs(pan)
}

/**
 * Applies the editor's effective framing without allowing the crop outside the
 * final displayed image. panX and panY are normalized controls in [-1, 1].
 */
export function applyZoomAndPan(
  crop: CropRect,
  displaySize: CropBounds,
  zoomValue = 1,
  panXValue = 0,
  panYValue = 0,
): CropRect {
  const zoom = clamp(finiteOr(zoomValue, 1), 1, 8)
  const width = clamp(crop.width / zoom, 1, displaySize.width)
  const height = clamp(crop.height / zoom, 1, displaySize.height)
  const centerX = crop.x + crop.width / 2
  const centerY = crop.y + crop.height / 2
  const maximumX = displaySize.width - width
  const maximumY = displaySize.height - height
  const panX = clamp(finiteOr(panXValue, 0), -1, 1)
  const panY = clamp(finiteOr(panYValue, 0), -1, 1)
  const neutralX = clamp(centerX - width / 2, 0, maximumX)
  const neutralY = clamp(centerY - height / 2, 0, maximumY)

  return {
    x: clamp(interpolatePanOrigin(neutralX, maximumX, panX), 0, maximumX),
    y: clamp(interpolatePanOrigin(neutralY, maximumY, panY), 0, maximumY),
    width,
    height,
  }
}

function constrainRectangularCrop(crop: CropRect, displaySize: CropBounds, preset: AspectRatioPreset): CropRect {
  if (preset === 'free') {
    return clampCropToBounds(crop, displaySize)
  }

  const ratio = getAspectRatio(preset, displaySize)
  const initialWidth = clamp(crop.width, 1, displaySize.width)
  const initialHeight = clamp(crop.height, 1, displaySize.height)
  let width = initialWidth
  let height = initialHeight

  if (width / height > ratio) {
    width = height * ratio
  } else {
    height = width / ratio
  }

  if (width > displaySize.width) {
    width = displaySize.width
    height = width / ratio
  }
  if (height > displaySize.height) {
    height = displaySize.height
    width = height * ratio
  }

  const centerX = crop.x + crop.width / 2
  const centerY = crop.y + crop.height / 2

  return {
    x: clamp(centerX - width / 2, 0, displaySize.width - width),
    y: clamp(centerY - height / 2, 0, displaySize.height - height),
    width,
    height,
  }
}

/** Fit all four crop corners inside the actual rotated image, not just its bounding box. */
export function constrainCrop(crop: CropRect, bounds: CropBounds, preset: AspectRatioPreset): CropRect {
  const rect = constrainRectangularCrop(crop, bounds, preset)
  if (!bounds.imageSize || !bounds.angle) return rect
  const radians = bounds.angle * Math.PI / 180
  const c = Math.cos(radians), s = Math.sin(radians)
  const image = bounds.imageSize
  const factor = Math.min(1,
    image.width / (Math.abs(c) * rect.width + Math.abs(s) * rect.height),
    image.height / (Math.abs(s) * rect.width + Math.abs(c) * rect.height),
  )
  const width = rect.width * factor, height = rect.height * factor
  const dx = rect.x + rect.width / 2 - bounds.width / 2
  const dy = rect.y + rect.height / 2 - bounds.height / 2
  const limitX = Math.max(0, (image.width - Math.abs(c) * width - Math.abs(s) * height) / 2)
  const limitY = Math.max(0, (image.height - Math.abs(s) * width - Math.abs(c) * height) / 2)
  const x = clamp(c * dx + s * dy, -limitX, limitX)
  const y = clamp(-s * dx + c * dy, -limitY, limitY)
  return { x: bounds.width / 2 + c * x - s * y - width / 2,
    y: bounds.height / 2 + s * x + c * y - height / 2, width, height }
}

function cropIsInside(crop: CropRect, bounds: CropBounds): boolean {
  const fitted = constrainCrop(crop, bounds, 'free')
  return (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(crop[key] - fitted[key]) < 1e-8)
}

/**
 * Resizes from the bottom-right handle while keeping the top-left anchor
 * fixed. For a locked ratio, the pointer delta is continuously projected onto
 * the ratio ray, so horizontal-only and vertical-only drags both resize the
 * frame without a discontinuity when the pointer changes direction.
 */
function resizeRectangularCropFromBottomRight(
  crop: CropRect,
  delta: Pick<CropRect, 'x' | 'y'>,
  displaySize: CropBounds,
  preset: AspectRatioPreset,
): CropRect {
  const availableWidth = Math.max(1, displaySize.width - crop.x)
  const availableHeight = Math.max(1, displaySize.height - crop.y)

  if (preset === 'free') {
    return {
      x: crop.x,
      y: crop.y,
      width: clamp(crop.width + delta.x, 1, availableWidth),
      height: clamp(crop.height + delta.y, 1, availableHeight),
    }
  }

  const ratio = getAspectRatio(preset, displaySize)
  const minimumWidth = Math.min(Math.max(1, ratio), availableWidth, availableHeight * ratio)
  const maximumWidth = Math.max(minimumWidth, Math.min(availableWidth, availableHeight * ratio))
  const ratioSquared = ratio * ratio
  const projectedWidth = crop.width + (
    (delta.x * ratioSquared + delta.y * ratio) / (ratioSquared + 1)
  )
  const width = clamp(projectedWidth, minimumWidth, maximumWidth)

  return {
    x: crop.x,
    y: crop.y,
    width,
    height: width / ratio,
  }
}

/** Stop a resize at the rotated image edge while retaining the top-left anchor. */
export function resizeCropFromBottomRight(
  crop: CropRect, delta: Pick<CropRect, 'x' | 'y'>, bounds: CropBounds, preset: AspectRatioPreset,
): CropRect {
  const target = resizeRectangularCropFromBottomRight(crop, delta, bounds, preset)
  if (!bounds.angle || cropIsInside(target, bounds)) return target
  let low = 0, high = 1
  const between = (t: number): CropRect => ({ ...crop,
    width: crop.width + (target.width - crop.width) * t,
    height: crop.height + (target.height - crop.height) * t })
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2
    if (cropIsInside(between(mid), bounds)) low = mid
    else high = mid
  }
  return between(low)
}

/** Translates a final-display crop by a pixel delta and keeps it constrained. */
export function translateCrop(
  crop: CropRect,
  delta: Pick<CropRect, 'x' | 'y'>,
  displaySize: CropBounds,
  preset: AspectRatioPreset,
): CropRect {
  return constrainCrop(
    { ...crop, x: crop.x + delta.x, y: crop.y + delta.y },
    displaySize,
    preset,
  )
}

function calculateOutputSize(croppedSize: Size, resize?: ResizeOptions): Size {
  if (!resize || (resize.width === undefined && resize.height === undefined)) {
    return {
      width: roundDimension(croppedSize.width),
      height: roundDimension(croppedSize.height),
    }
  }

  if (resize.width !== undefined && resize.height !== undefined) {
    const scale = Math.min(resize.width / croppedSize.width, resize.height / croppedSize.height)
    return {
      width: roundDimension(croppedSize.width * scale),
      height: roundDimension(croppedSize.height * scale),
    }
  }

  if (resize.width !== undefined) {
    return {
      width: roundDimension(resize.width),
      height: roundDimension(resize.width * croppedSize.height / croppedSize.width),
    }
  }

  if (resize.height === undefined) {
    throw new Error('Resize options require a width or height.')
  }

  const height = resize.height
  return {
    width: roundDimension(height * croppedSize.width / croppedSize.height),
    height: roundDimension(height),
  }
}

interface Point {
  readonly x: number
  readonly y: number
}

function getDisplaySize(sourceSize: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: sourceSize.height, height: sourceSize.width }
    : sourceSize
}

/** Straightening preserves source scale; the display expands to show every pixel. */
export function calculateStraightening(_displaySize: Size, degrees = 0): ImageGeometry['straightening'] {
  if (!Number.isFinite(degrees) || Math.abs(degrees) > 45) {
    throw new Error('Straightening must be between -45 and 45 degrees.')
  }
  return { degrees, scale: 1 }
}

function getCropBounds(sourceSize: Size, state: ImageEditState): CropBounds {
  const imageSize = getDisplaySize(sourceSize, state.rotation)
  const { degrees } = calculateStraightening(imageSize, state.straighten)
  if (degrees === 0) return imageSize
  const c = Math.cos(degrees * Math.PI / 180), s = Math.abs(Math.sin(degrees * Math.PI / 180))
  return {
    width: Math.ceil(imageSize.width * c + imageSize.height * s),
    height: Math.ceil(imageSize.height * c + imageSize.width * s),
    imageSize,
    angle: degrees * (state.flipHorizontal !== state.flipVertical ? -1 : 1),
  }
}

/** Keep the crop centered in the new frame, then fit it to the actual image. */
export function straightenEditState(sourceSize: Size, state: ImageEditState, degrees: number): ImageEditState {
  const before = calculateImageGeometry(sourceSize, state)
  const bounds = getCropBounds(sourceSize, { ...state, straighten: degrees })
  const crop = constrainCrop({ ...before.crop,
    x: before.crop.x + (bounds.width - before.displaySize.width) / 2,
    y: before.crop.y + (bounds.height - before.displaySize.height) / 2,
  }, bounds, state.aspectRatio)
  return { ...state, straighten: degrees, crop, zoom: 1, panX: 0, panY: 0 }
}

function mapDisplayedPointToSource(
  sourceSize: Size,
  rotation: Rotation,
  displaySize: CropBounds,
  point: Point,
  flipHorizontal: boolean,
  flipVertical: boolean,
  straightening: ImageGeometry['straightening'],
): Point {
  let unflippedPoint = {
    x: flipHorizontal ? displaySize.width - point.x : point.x,
    y: flipVertical ? displaySize.height - point.y : point.y,
  }

  if (straightening.degrees !== 0) {
    const radians = -straightening.degrees * Math.PI / 180
    const x = (unflippedPoint.x - displaySize.width / 2) / straightening.scale
    const y = (unflippedPoint.y - displaySize.height / 2) / straightening.scale
    unflippedPoint = {
      x: x * Math.cos(radians) - y * Math.sin(radians) + (displaySize.imageSize ?? displaySize).width / 2,
      y: x * Math.sin(radians) + y * Math.cos(radians) + (displaySize.imageSize ?? displaySize).height / 2,
    }
  }

  switch (rotation) {
    case 0:
      return unflippedPoint
    case 90:
      return { x: unflippedPoint.y, y: sourceSize.height - unflippedPoint.x }
    case 180:
      return {
        x: sourceSize.width - unflippedPoint.x,
        y: sourceSize.height - unflippedPoint.y,
      }
    case 270:
      return { x: sourceSize.width - unflippedPoint.y, y: unflippedPoint.x }
  }
}

function mapCropToSource(
  sourceSize: Size,
  rotation: Rotation,
  displaySize: CropBounds,
  crop: CropRect,
  flipHorizontal: boolean,
  flipVertical: boolean,
  straightening: ImageGeometry['straightening'],
): CropRect {
  const corners: readonly Point[] = [
    { x: crop.x, y: crop.y },
    { x: crop.x + crop.width, y: crop.y },
    { x: crop.x, y: crop.y + crop.height },
    { x: crop.x + crop.width, y: crop.y + crop.height },
  ]
  const sourceCorners = corners.map((corner) =>
    mapDisplayedPointToSource(
      sourceSize,
      rotation,
      displaySize,
      corner,
      flipHorizontal,
      flipVertical,
      straightening,
    ),
  )
  const minX = Math.min(...sourceCorners.map((corner) => corner.x))
  const minY = Math.min(...sourceCorners.map((corner) => corner.y))
  const maxX = Math.max(...sourceCorners.map((corner) => corner.x))
  const maxY = Math.max(...sourceCorners.map((corner) => corner.y))

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function createEditState(sourceSize: Size): ImageEditState {
  return {
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
    crop: { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height },
    aspectRatio: 'original',
    zoom: 1,
    panX: 0,
    panY: 0,
  }
}

function getNextRotation(rotation: Rotation, degrees: 90 | -90): Rotation {
  return ((rotation + degrees + 360) % 360) as Rotation
}

function rotateCrop(
  crop: CropRect,
  displaySize: CropBounds,
  degrees: 90 | -90,
): CropRect {
  return degrees === 90
    ? {
        x: crop.y,
        y: displaySize.width - crop.x - crop.width,
        width: crop.height,
        height: crop.width,
      }
    : {
        x: displaySize.height - crop.y - crop.height,
        y: crop.x,
        width: crop.height,
        height: crop.width,
      }
}

/**
 * Rotates an edit state while keeping its crop in final displayed-orientation
 * pixels. Every display size is derived from the normalized source size and
 * the next absolute rotation.
 */
export function rotateEditState(
  sourceSize: Size,
  state: ImageEditState,
  degrees: 90 | -90,
): ImageEditState {
  const currentGeometry = calculateImageGeometry(sourceSize, state)
  const nextRotation = getNextRotation(state.rotation, degrees)
  const currentDisplaySize = currentGeometry.displaySize
  const nextDisplaySize = getCropBounds(sourceSize, { ...state, rotation: nextRotation })
  const nextCrop = rotateCrop(currentGeometry.crop, currentDisplaySize, degrees)

  return {
    ...state,
    rotation: nextRotation,
    crop: constrainCrop(nextCrop, nextDisplaySize, state.aspectRatio),
    zoom: 1,
    panX: 0,
    panY: 0,
  }
}

export function calculateImageGeometry(sourceSize: Size, state: ImageEditState): ImageGeometry {
  const displaySize = getCropBounds(sourceSize, state)
  const straightening = calculateStraightening(displaySize, state.straighten)
  const constrainedCrop = constrainCrop(state.crop, displaySize, state.aspectRatio)
  const crop = constrainCrop(applyZoomAndPan(
    constrainedCrop,
    displaySize,
    state.zoom,
    state.panX,
    state.panY,
  ), displaySize, state.aspectRatio)
  const croppedSize = { width: crop.width, height: crop.height }

  return {
    displaySize,
    straightening,
    crop,
    sourceCrop: mapCropToSource(
      sourceSize,
      state.rotation,
      displaySize,
      crop,
      state.flipHorizontal,
      state.flipVertical,
      straightening,
    ),
    croppedSize,
    outputSize: calculateOutputSize(croppedSize, state.resize),
    transformOrder: TRANSFORM_ORDER,
  }
}

export type CropCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Reflect other corners into the existing bottom-right resize, then reflect back. */
export function resizeCropFromCorner(
  crop: CropRect, delta: Pick<CropRect, 'x' | 'y'>, bounds: CropBounds,
  preset: AspectRatioPreset, corner: CropCorner,
): CropRect {
  const sx = corner.endsWith('left') ? -1 : 1
  const sy = corner.startsWith('top') ? -1 : 1
  const reflect = (r: CropRect): CropRect => ({
    ...r,
    x: sx < 0 ? bounds.width - r.x - r.width : r.x,
    y: sy < 0 ? bounds.height - r.y - r.height : r.y,
  })
  return reflect(resizeCropFromBottomRight(
    reflect(crop), { x: delta.x * sx, y: delta.y * sy },
    { ...bounds, angle: (bounds.angle ?? 0) * sx * sy }, preset,
  ))
}
