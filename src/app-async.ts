export interface ResultIntent {
  readonly source: object
  readonly edit: object
  readonly outputMime: string
  readonly quality: number
}

export function isSameResultIntent(
  current: ResultIntent | undefined,
  expected: ResultIntent,
): boolean {
  return current !== undefined &&
    current.source === expected.source &&
    current.edit === expected.edit &&
    current.outputMime === expected.outputMime &&
    current.quality === expected.quality
}
