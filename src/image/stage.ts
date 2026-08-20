import type { Rotation, Size } from './geometry'

export const CROP_SURFACE_MAX_HEIGHT_REM = 42

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
): string {
  return [
    'translate(-50%, -50%)',
    `scaleX(${flipHorizontal ? -1 : 1})`,
    `scaleY(${flipVertical ? -1 : 1})`,
    `rotate(${rotation}deg)`,
  ].join(' ')
}

export function getCropSurfaceMaxWidthRem(
  displaySize: Size,
  maxHeightRem = CROP_SURFACE_MAX_HEIGHT_REM,
): number {
  if (
    !Number.isFinite(displaySize.width) ||
    displaySize.width <= 0 ||
    !Number.isFinite(displaySize.height) ||
    displaySize.height <= 0 ||
    !Number.isFinite(maxHeightRem) ||
    maxHeightRem <= 0
  ) {
    throw new Error('Crop surface dimensions and height cap must be positive numbers.')
  }
  return maxHeightRem * displaySize.width / displaySize.height
}

export function createCropSurfaceStyle(displaySize: Size): CropSurfaceStyle {
  return {
    aspectRatio: `${displaySize.width} / ${displaySize.height}`,
    maxWidth: `${getCropSurfaceMaxWidthRem(displaySize)}rem`,
    marginInline: 'auto',
  }
}
