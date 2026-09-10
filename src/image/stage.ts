import type { ImageGeometry, Rotation, Size } from './geometry'

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

/** Place the entire resize target at the nearest unoccluded viewport position. */
export function placeCropHandle(
  corner: { x: number; y: number },
  viewport: Size,
  size: number,
  controls: readonly { x: number; y: number; width: number; height: number }[],
): { left: number; top: number } {
  const maxX = Math.max(0, viewport.width - size)
  const maxY = Math.max(0, viewport.height - size)
  const clampX = (x: number) => Math.max(0, Math.min(maxX, x))
  const clampY = (y: number) => Math.max(0, Math.min(maxY, y))
  const preferred = { left: clampX(corner.x - size), top: clampY(corner.y - size) }
  const obstacles = controls.map(r => ({ x: r.x - 2, y: r.y - 2, right: r.x + r.width + 2, bottom: r.y + r.height + 2 }))
  const xs = [preferred.left, 0, maxX, ...obstacles.flatMap(r => [clampX(r.x - size), clampX(r.right)])]
  const ys = [preferred.top, 0, maxY, ...obstacles.flatMap(r => [clampY(r.y - size), clampY(r.bottom)])]
  let best: typeof preferred | undefined
  let distance = Infinity
  for (const left of xs) for (const top of ys) {
    if (obstacles.some(r => left < r.right && left + size > r.x && top < r.bottom && top + size > r.y)) continue
    const nextDistance = (left - preferred.left) ** 2 + (top - preferred.top) ** 2
    if (nextDistance < distance) {
      best = { left, top }
      distance = nextDistance
    }
  }
  // ponytail: if controls cover every 44px slot, keyboard resizing remains the fallback.
  return best ?? preferred
}

export interface ViewTransform { zoom: number; x: number; y: number }

/** Zoom about a screen point relative to the viewport centre; never changes the image edit. */
export function zoomView(view: ViewTransform, delta: number, point: { x: number; y: number }): ViewTransform {
  const zoom = Math.max(0.01, Math.min(16, view.zoom * Math.exp(-Math.max(-1000, Math.min(1000, delta)) * 0.002)))
  const ratio = zoom / view.zoom
  return { zoom, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }
}
