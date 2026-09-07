import type { ImageGeometry, Rotation, Size } from './geometry'

export interface CropSurfaceStyle {
  readonly aspectRatio: string
  readonly maxWidth: string
  readonly marginInline: 'auto'
}

/**
 * CSS transform functions apply from right to left. Rotation therefore has to
 * be the rightmost operation so the scale functions flip the final display
 * axes, matching the worker's rotate-then-flip pipeline.
 */
export function createStageTransform(
  rotation: Rotation,
  flipHorizontal: boolean,
  flipVertical: boolean,
  straightening: ImageGeometry['straightening'] = { degrees: 0, scale: 1 },
): string {
  return [
    'translate(-50%, -50%)',
    `scaleX(${flipHorizontal ? -1 : 1})`,
    `scaleY(${flipVertical ? -1 : 1})`,
    ...(straightening.degrees === 0 ? [] : [`scale(${straightening.scale})`]),
    `rotate(${rotation + straightening.degrees}deg)`,
  ].join(' ')
}

export function createCropSurfaceStyle(displaySize: Size): CropSurfaceStyle {
  if (
    !Number.isFinite(displaySize.width) ||
    displaySize.width <= 0 ||
    !Number.isFinite(displaySize.height) ||
    displaySize.height <= 0
  ) {
    throw new Error('Crop surface dimensions must be positive numbers.')
  }

  return {
    aspectRatio: `${displaySize.width} / ${displaySize.height}`,
    maxWidth: `min(100%, calc(100cqh * ${displaySize.width / displaySize.height}))`,
    marginInline: 'auto',
  }
}
