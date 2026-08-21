import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent } from 'react'

import { isSameResultIntent, type ResultIntent } from './app-async'
import {
  calculateImageGeometry,
  constrainCrop,
  createEditState,
  rotateEditState,
  type AspectRatioPreset,
  type CropRect,
  type ImageEditState,
  type Size,
} from './image/geometry'
import {
  calculateMetrics,
  createRasterProcessor,
  decodeImageFile,
  getOutputExtension,
  isSupportedImageMimeType,
  sanitizeDownloadFilename,
  type DecodedSourcePixels,
  type OutputMime,
  type RasterProcessor,
  type RasterResult,
} from './image/raster'
import { createCropSurfaceStyle, createStageTransform } from './image/stage'

const ASPECT_OPTIONS: readonly { value: AspectRatioPreset; label: string }[] = [
  { value: 'free', label: '自由' },
  { value: 'original', label: '元画像' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
]

const OUTPUT_OPTIONS: readonly { value: OutputMime; label: string }[] = [
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/png', label: 'PNG' },
  { value: 'image/webp', label: 'WebP' },
]

const PREVIEW_MAX_DIMENSION = 960

interface SourceAsset {
  readonly file: File
  readonly pixels: DecodedSourcePixels
  readonly objectUrl: string
}

type CropInteractionMode = 'move' | 'resize'

interface CropInteraction {
  readonly pointerId: number
  readonly mode: CropInteractionMode
  readonly startX: number
  readonly startY: number
  readonly startCrop: CropRect
  readonly startPanX: number
  readonly startPanY: number
  readonly displaySize: Size
  readonly startGeometryCrop: CropRect
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDimensions(size: Size | undefined): string {
  return size ? `${Math.round(size.width)} × ${Math.round(size.height)} px` : '—'
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function App() {
  const [asset, setAsset] = useState<SourceAsset | undefined>()
  const [editState, setEditState] = useState<ImageEditState | undefined>()
  const [outputMime, setOutputMime] = useState<OutputMime>('image/jpeg')
  const [quality, setQuality] = useState(0.82)
  const [renderedResult, setRenderedResult] = useState<RasterResult | undefined>()
  const [renderedUrl, setRenderedUrl] = useState('')
  const [renderedIsPreview, setRenderedIsPreview] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [processorReady, setProcessorReady] = useState(false)
  const processorRef = useRef<RasterProcessor | undefined>(undefined)
  const sourceUrlRef = useRef<string | undefined>(undefined)
  const renderedUrlRef = useRef<string | undefined>(undefined)
  const fileLoadGenerationRef = useRef(0)
  const resultIntentGenerationRef = useRef(0)
  const previewRequestIdRef = useRef(0)
  const exportRequestIdRef = useRef(0)
  const exportActiveRef = useRef<{ requestId: number; intentGeneration: number } | undefined>(undefined)
  const currentIntentRef = useRef<ResultIntent | undefined>(undefined)
  const cropSurfaceRef = useRef<HTMLDivElement | null>(null)
  const cropInteractionRef = useRef<CropInteraction | undefined>(undefined)

  currentIntentRef.current = asset && editState
    ? {
        source: asset,
        edit: editState,
        outputMime,
        quality,
      }
    : undefined

  const invalidateResultIntent = () => {
    resultIntentGenerationRef.current += 1
    previewRequestIdRef.current += 1
  }

  const geometry = useMemo(() => {
    if (!asset || !editState) {
      return undefined
    }
    return calculateImageGeometry(
      { width: asset.pixels.width, height: asset.pixels.height },
      editState,
    )
  }, [asset, editState])

  const metrics = useMemo(() => {
    if (!asset || !renderedResult) {
      return undefined
    }
    return calculateMetrics(
      { bytes: asset.file.size },
      {
        width: renderedResult.width,
        height: renderedResult.height,
        bytes: renderedResult.bytes,
      },
    )
  }, [asset, renderedResult])

  const releaseRenderedUrl = () => {
    if (renderedUrlRef.current) {
      URL.revokeObjectURL(renderedUrlRef.current)
      renderedUrlRef.current = undefined
    }
    setRenderedUrl('')
    setRenderedResult(undefined)
  }

  const adoptRenderedResult = (result: RasterResult, isPreview: boolean): string => {
    if (renderedUrlRef.current) {
      URL.revokeObjectURL(renderedUrlRef.current)
    }
    const url = URL.createObjectURL(result.blob)
    renderedUrlRef.current = url
    setRenderedUrl(url)
    setRenderedResult(result)
    setRenderedIsPreview(isPreview)
    return url
  }

  useEffect(() => {
    let processor: RasterProcessor | undefined
    try {
      processor = createRasterProcessor()
      processorRef.current = processor
      setProcessorReady(true)
    } catch (error) {
      setErrorMessage(getErrorMessage(error, '画像処理ワーカーを起動できませんでした。'))
    }

    return () => {
      fileLoadGenerationRef.current += 1
      invalidateResultIntent()
      exportRequestIdRef.current += 1
      exportActiveRef.current = undefined
      processor?.dispose()
      processorRef.current = undefined
      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current)
        sourceUrlRef.current = undefined
      }
      if (renderedUrlRef.current) {
        URL.revokeObjectURL(renderedUrlRef.current)
        renderedUrlRef.current = undefined
      }
    }
  }, [])

  useEffect(() => {
    if (!asset || !editState || !geometry || !processorReady) {
      return undefined
    }
    const processor = processorRef.current
    if (!processor) {
      return undefined
    }

    const intentGeneration = resultIntentGenerationRef.current
    if (exportActiveRef.current?.intentGeneration === intentGeneration) {
      return undefined
    }

    const requestId = ++previewRequestIdRef.current
    setBusy(true)
    setErrorMessage('')
    const timeoutId = window.setTimeout(() => {
      if (exportActiveRef.current?.intentGeneration === intentGeneration) {
        return
      }
      const output = {
        mimeType: outputMime,
        quality,
        preview: true,
        maxPreviewDimension: PREVIEW_MAX_DIMENSION,
      }

      void processor.process(asset.pixels, editState, output)
        .then((result) => {
          if (
            previewRequestIdRef.current !== requestId ||
            resultIntentGenerationRef.current !== intentGeneration
          ) {
            return
          }
          adoptRenderedResult(result, true)
          if (exportActiveRef.current?.intentGeneration !== intentGeneration) {
            setBusy(false)
          }
        })
        .catch((error: unknown) => {
          if (
            previewRequestIdRef.current !== requestId ||
            resultIntentGenerationRef.current !== intentGeneration
          ) {
            return
          }
          if (exportActiveRef.current?.intentGeneration !== intentGeneration) {
            setBusy(false)
            setErrorMessage(getErrorMessage(error, 'プレビューを生成できませんでした。'))
          }
        })
    }, 160)

    return () => window.clearTimeout(timeoutId)
  }, [asset, editState, geometry, outputMime, processorReady, quality])

  const handleFile = async (file: File | undefined) => {
    if (!file) {
      return
    }
    const loadGeneration = ++fileLoadGenerationRef.current
    invalidateResultIntent()
    const mimeType = file.type.toLowerCase()
    if (!isSupportedImageMimeType(mimeType)) {
      setBusy(false)
      setErrorMessage('JPEG、PNG、WebP の画像だけを選択してください。')
      return
    }

    setBusy(true)
    setErrorMessage('')
    try {
      const pixels = await decodeImageFile(file)
      if (fileLoadGenerationRef.current !== loadGeneration) {
        return
      }
      const objectUrl = URL.createObjectURL(file)
      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current)
      }
      sourceUrlRef.current = objectUrl
      processorRef.current?.clearSource()
      releaseRenderedUrl()
      setAsset({ file, pixels, objectUrl })
      setEditState(createEditState({ width: pixels.width, height: pixels.height }))
      setBusy(false)
    } catch (error) {
      if (fileLoadGenerationRef.current !== loadGeneration) {
        return
      }
      setBusy(false)
      setErrorMessage(getErrorMessage(error, '画像を読み込めませんでした。'))
    }
  }

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    void handleFile(event.target.files?.[0])
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(false)
    void handleFile(event.dataTransfer.files[0])
  }

  const resetEdits = () => {
    if (!asset) {
      return
    }
    fileLoadGenerationRef.current += 1
    invalidateResultIntent()
    processorRef.current?.clearSource()
    setEditState(createEditState({ width: asset.pixels.width, height: asset.pixels.height }))
    releaseRenderedUrl()
    setErrorMessage('')
    setBusy(false)
  }

  const updateEditState = (update: (current: ImageEditState) => ImageEditState) => {
    invalidateResultIntent()
    setEditState((current) => current ? update(current) : current)
  }

  const updateOutputMime = (nextOutputMime: OutputMime) => {
    invalidateResultIntent()
    setOutputMime(nextOutputMime)
  }

  const updateQuality = (nextQuality: number) => {
    invalidateResultIntent()
    setQuality(nextQuality)
  }

  const setAspectRatio = (nextAspectRatio: AspectRatioPreset) => {
    updateEditState((current) => {
      if (!geometry) {
        return { ...current, aspectRatio: nextAspectRatio }
      }
      const crop = constrainCrop(
        geometry.crop,
        geometry.displaySize,
        nextAspectRatio,
      )
      return {
        ...current,
        aspectRatio: nextAspectRatio,
        crop,
        zoom: 1,
        panX: 0,
        panY: 0,
      }
    })
  }

  const rotateBy = (degrees: 90 | -90) => {
    updateEditState((current) => {
      if (!asset) {
        return current
      }
      return rotateEditState(
        { width: asset.pixels.width, height: asset.pixels.height },
        current,
        degrees,
      )
    })
  }

  const updateCropField = (field: keyof Pick<CropRect, 'x' | 'y' | 'width' | 'height'>, value: number) => {
    if (!Number.isFinite(value) || !geometry) {
      return
    }
    updateEditState((current) => {
      const nextCrop = { ...geometry.crop, [field]: Math.max(1, value) }
      return {
        ...current,
        crop: constrainCrop(nextCrop, geometry.displaySize, current.aspectRatio),
        zoom: 1,
        panX: 0,
        panY: 0,
      }
    })
  }

  const updateResize = (field: 'width' | 'height', rawValue: string) => {
    const numericValue = rawValue === '' ? undefined : Number(rawValue)
    if (numericValue !== undefined && (!Number.isFinite(numericValue) || numericValue < 1)) {
      return
    }
    updateEditState((current) => {
      const otherField = field === 'width' ? 'height' : 'width'
      const otherValue = current.resize?.[otherField]
      if (numericValue === undefined && otherValue === undefined) {
        const next = { ...current }
        delete next.resize
        return next
      }
      return {
        ...current,
        resize: field === 'width'
          ? numericValue === undefined
            ? { height: otherValue as number }
            : otherValue === undefined
              ? { width: numericValue }
              : { width: numericValue, height: otherValue }
          : numericValue === undefined
            ? { width: otherValue as number }
            : otherValue === undefined
              ? { height: numericValue }
              : { width: otherValue, height: numericValue },
      }
    })
  }

  const beginCropInteraction = (
    event: ReactPointerEvent<HTMLElement>,
    mode: CropInteractionMode,
  ) => {
    if (!editState || !geometry || !cropSurfaceRef.current) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    cropSurfaceRef.current.setPointerCapture(event.pointerId)
    cropInteractionRef.current = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: editState.crop,
      startPanX: editState.panX ?? 0,
      startPanY: editState.panY ?? 0,
      displaySize: geometry.displaySize,
      startGeometryCrop: geometry.crop,
    }
  }

  const moveCropInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = cropInteractionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId || !cropSurfaceRef.current) {
      return
    }
    const bounds = cropSurfaceRef.current.getBoundingClientRect()
    const deltaX = (event.clientX - interaction.startX) / bounds.width * interaction.displaySize.width
    const deltaY = (event.clientY - interaction.startY) / bounds.height * interaction.displaySize.height

    if (interaction.mode === 'resize') {
      updateEditState((current) => ({
        ...current,
        crop: constrainCrop(
          {
            ...interaction.startCrop,
            width: Math.max(1, interaction.startCrop.width + deltaX),
            height: Math.max(1, interaction.startCrop.height + deltaY),
          },
          interaction.displaySize,
          current.aspectRatio,
        ),
        zoom: 1,
        panX: 0,
        panY: 0,
      }))
      return
    }

    const travelX = interaction.displaySize.width - interaction.startGeometryCrop.width
    const travelY = interaction.displaySize.height - interaction.startGeometryCrop.height
    if (travelX > 1 || travelY > 1) {
      updateEditState((current) => ({
        ...current,
        panX: travelX > 1
          ? clamp(interaction.startPanX + deltaX / (travelX / 2), -1, 1)
          : interaction.startPanX,
        panY: travelY > 1
          ? clamp(interaction.startPanY + deltaY / (travelY / 2), -1, 1)
          : interaction.startPanY,
      }))
    } else {
      updateEditState((current) => ({
        ...current,
        crop: constrainCrop(
          {
            ...interaction.startCrop,
            x: interaction.startCrop.x + deltaX,
            y: interaction.startCrop.y + deltaY,
          },
          interaction.displaySize,
          current.aspectRatio,
        ),
      }))
    }
  }

  const endCropInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (cropInteractionRef.current?.pointerId === event.pointerId) {
      cropInteractionRef.current = undefined
      if (cropSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
        cropSurfaceRef.current.releasePointerCapture(event.pointerId)
      }
    }
  }

  const moveCropWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!geometry) {
      return
    }
    const step = event.shiftKey ? 10 : 1
    const delta = event.key === 'ArrowLeft'
      ? { x: -step, y: 0 }
      : event.key === 'ArrowRight'
        ? { x: step, y: 0 }
        : event.key === 'ArrowUp'
          ? { x: 0, y: -step }
          : event.key === 'ArrowDown'
            ? { x: 0, y: step }
            : undefined
    if (!delta) {
      return
    }
    event.preventDefault()
    updateEditState((current) => ({
      ...current,
      crop: constrainCrop(
        { ...geometry.crop, x: geometry.crop.x + delta.x, y: geometry.crop.y + delta.y },
        geometry.displaySize,
        current.aspectRatio,
      ),
      zoom: 1,
      panX: 0,
      panY: 0,
    }))
  }

  const download = async () => {
    if (!asset || !editState || !processorRef.current) {
      return
    }
    const expectedIntent: ResultIntent = {
      source: asset,
      edit: editState,
      outputMime,
      quality,
    }
    const intentGeneration = resultIntentGenerationRef.current
    const processor = processorRef.current
    const requestId = ++exportRequestIdRef.current
    exportActiveRef.current = { requestId, intentGeneration }
    setBusy(true)
    setErrorMessage('')
    const output = { mimeType: outputMime, quality, preview: false }

    try {
      const result = await processor.process(asset.pixels, editState, output)
      const isCurrent = exportActiveRef.current?.requestId === requestId &&
        resultIntentGenerationRef.current === intentGeneration &&
        isSameResultIntent(currentIntentRef.current, expectedIntent)
      if (!isCurrent) {
        return
      }
      const downloadUrl = adoptRenderedResult(result, false)
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = sanitizeDownloadFilename(asset.file.name, outputMime)
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setBusy(false)
    } catch (error) {
      const isCurrent = exportActiveRef.current?.requestId === requestId &&
        resultIntentGenerationRef.current === intentGeneration &&
        isSameResultIntent(currentIntentRef.current, expectedIntent)
      if (isCurrent) {
        setBusy(false)
        setErrorMessage(getErrorMessage(error, 'ダウンロード用の画像を生成できませんでした。'))
      }
    } finally {
      if (exportActiveRef.current?.requestId === requestId) {
        exportActiveRef.current = undefined
      }
    }
  }

  const currentCrop = geometry?.crop ?? { x: 0, y: 0, width: 1, height: 1 }
  const cropStyle = currentCrop && geometry
    ? {
        left: `${currentCrop.x / geometry.displaySize.width * 100}%`,
        top: `${currentCrop.y / geometry.displaySize.height * 100}%`,
        width: `${currentCrop.width / geometry.displaySize.width * 100}%`,
        height: `${currentCrop.height / geometry.displaySize.height * 100}%`,
      }
    : undefined

  const stageImageStyle = geometry && asset && editState
    ? {
        left: '50%',
        top: '50%',
        width: `${asset.pixels.width / geometry.displaySize.width * 100}%`,
        height: `${asset.pixels.height / geometry.displaySize.height * 100}%`,
        transform: createStageTransform(editState.rotation, editState.flipHorizontal, editState.flipVertical),
      }
    : undefined
  const cropSurfaceStyle = geometry ? createCropSurfaceStyle(geometry.displaySize) : undefined

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">image-compressor-web</p>
        <h1>画像を、ブラウザの中だけで整える。</h1>
        <p className="lead">
          選んだ画像をここでトリミング、回転、反転、リサイズして、必要な形式で保存できます。画像データは外部へ送信しません。
        </p>
      </header>

      <section className="privacy-card" aria-label="プライバシー情報">
        <span className="privacy-icon" aria-hidden="true">◎</span>
        <p>
          すべての処理はこのブラウザ内で完結します。ピクセルにデコードしてから再エンコードするため、出力画像のメタデータは削除されます。JPEGの回転もロスレス変換ではなく再エンコードです。
        </p>
      </section>

      <label
        className={`drop-zone${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input
          className="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleInputChange}
        />
        <span className="drop-title">JPEG・PNG・WebPを選ぶ</span>
        <span className="drop-detail">クリックまたはドラッグ＆ドロップ。静止画のみ対応。</span>
      </label>

      {asset && editState && geometry ? (
        <>
          <section className="workspace" aria-label="画像エディター">
            <div className="editor-column">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">EDITOR</p>
                  <h2>切り抜きと見え方</h2>
                </div>
                <span className={`status-chip${busy ? ' is-busy' : ''}`} role="status" aria-live="polite">
                  {busy ? '処理中…' : renderedResult ? 'プレビュー準備完了' : '画像を準備中'}
                </span>
              </div>

              <div
                ref={cropSurfaceRef}
                className="crop-surface"
                style={cropSurfaceStyle}
                onPointerMove={moveCropInteraction}
                onPointerUp={endCropInteraction}
                onPointerCancel={endCropInteraction}
              >
                <img
                  className="stage-image"
                  src={asset.objectUrl}
                  alt={`${asset.file.name} の編集対象`}
                  draggable={false}
                  style={stageImageStyle}
                />
                <div className="crop-shade crop-shade-top" style={{ height: cropStyle?.top }} />
                <div className="crop-shade crop-shade-bottom" style={{ height: cropStyle ? `${100 - Number.parseFloat(cropStyle.top) - Number.parseFloat(cropStyle.height)}%` : undefined }} />
                <div className="crop-shade crop-shade-left" style={{ top: cropStyle?.top, width: cropStyle?.left, height: cropStyle?.height }} />
                <div className="crop-shade crop-shade-right" style={{ top: cropStyle?.top, width: cropStyle ? `${100 - Number.parseFloat(cropStyle.left) - Number.parseFloat(cropStyle.width)}%` : undefined, height: cropStyle?.height }} />
                <div
                  className="crop-rectangle"
                  style={cropStyle}
                  role="group"
                  tabIndex={0}
                  aria-label="切り抜き範囲。矢印キーで移動、Shiftで大きく移動"
                  onKeyDown={moveCropWithKeyboard}
                  onPointerDown={(event) => beginCropInteraction(event, 'move')}
                >
                  <span className="crop-grid" aria-hidden="true" />
                  <button
                    className="crop-handle"
                    type="button"
                    aria-label="切り抜き範囲をリサイズ"
                    onPointerDown={(event) => beginCropInteraction(event, 'resize')}
                  />
                </div>
              </div>

              <div className="crop-coordinates" aria-label="切り抜き数値 controls">
                <label>
                  X
                  <input type="number" min="0" step="1" value={Math.round(currentCrop.x)} onChange={(event) => updateCropField('x', event.currentTarget.valueAsNumber)} />
                </label>
                <label>
                  Y
                  <input type="number" min="0" step="1" value={Math.round(currentCrop.y)} onChange={(event) => updateCropField('y', event.currentTarget.valueAsNumber)} />
                </label>
                <label>
                  幅
                  <input type="number" min="1" step="1" value={Math.round(currentCrop.width)} onChange={(event) => updateCropField('width', event.currentTarget.valueAsNumber)} />
                </label>
                <label>
                  高さ
                  <input type="number" min="1" step="1" value={Math.round(currentCrop.height)} onChange={(event) => updateCropField('height', event.currentTarget.valueAsNumber)} />
                </label>
              </div>

              <div className="control-card">
                <div className="control-row">
                  <label htmlFor="aspect-ratio">アスペクト比</label>
                  <select id="aspect-ratio" value={editState.aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatioPreset)}>
                    {ASPECT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="range-control">
                  <div className="range-label"><label htmlFor="zoom">ズーム</label><output htmlFor="zoom">{(editState.zoom ?? 1).toFixed(2)}×</output></div>
                  <input id="zoom" type="range" min="1" max="8" step="0.01" value={editState.zoom ?? 1} onChange={(event) => updateEditState((current) => ({ ...current, zoom: Number(event.target.value) }))} />
                </div>
                <div className="range-control">
                  <div className="range-label"><label htmlFor="pan-x">パン X</label><output htmlFor="pan-x">{(editState.panX ?? 0).toFixed(2)}</output></div>
                  <input id="pan-x" type="range" min="-1" max="1" step="0.01" value={editState.panX ?? 0} onChange={(event) => updateEditState((current) => ({ ...current, panX: Number(event.target.value) }))} />
                </div>
                <div className="range-control">
                  <div className="range-label"><label htmlFor="pan-y">パン Y</label><output htmlFor="pan-y">{(editState.panY ?? 0).toFixed(2)}</output></div>
                  <input id="pan-y" type="range" min="-1" max="1" step="0.01" value={editState.panY ?? 0} onChange={(event) => updateEditState((current) => ({ ...current, panY: Number(event.target.value) }))} />
                </div>
                <p className="control-hint">画像上の範囲をドラッグするか、数値・スライダーで同じ操作ができます。</p>
              </div>

              <div className="button-row">
                <button type="button" className="secondary-button" onClick={() => rotateBy(-90)}>↺ 左へ90°</button>
                <button type="button" className="secondary-button" onClick={() => rotateBy(90)}>↻ 右へ90°</button>
                <button type="button" className={`secondary-button${editState.flipHorizontal ? ' is-selected' : ''}`} onClick={() => updateEditState((current) => ({ ...current, flipHorizontal: !current.flipHorizontal }))}>↔ 左右反転</button>
                <button type="button" className={`secondary-button${editState.flipVertical ? ' is-selected' : ''}`} onClick={() => updateEditState((current) => ({ ...current, flipVertical: !current.flipVertical }))}>↕ 上下反転</button>
                <button type="button" className="text-button" onClick={resetEdits}>編集をリセット</button>
              </div>
            </div>

            <aside className="settings-column" aria-label="出力設定">
              <div className="section-heading compact-heading">
                <div>
                  <p className="section-kicker">OUTPUT</p>
                  <h2>保存設定</h2>
                </div>
              </div>
              <div className="control-card output-card">
                <label className="field-label" htmlFor="output-format">形式</label>
                <select id="output-format" value={outputMime} onChange={(event) => updateOutputMime(event.target.value as OutputMime)}>
                  {OUTPUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>

                {outputMime === 'image/png' ? null : (
                  <div className="range-control quality-control">
                    <div className="range-label"><label htmlFor="quality">品質</label><output htmlFor="quality">{Math.round(quality * 100)}%</output></div>
                    <input id="quality" type="range" min="0.01" max="1" step="0.01" value={quality} onChange={(event) => updateQuality(Number(event.target.value))} />
                    <span className="field-help">JPEG・WebPのみ</span>
                  </div>
                )}

                <div className="resize-fields">
                  <div className="field-label-row"><span className="field-label">出力サイズ</span><span className="field-help">幅または高さ</span></div>
                  <label htmlFor="resize-width">幅<input id="resize-width" type="number" min="1" step="1" placeholder="自動" value={editState.resize?.width ?? ''} onChange={(event) => updateResize('width', event.target.value)} /></label>
                  <label htmlFor="resize-height">高さ<input id="resize-height" type="number" min="1" step="1" placeholder="自動" value={editState.resize?.height ?? ''} onChange={(event) => updateResize('height', event.target.value)} /></label>
                </div>
                <div className="effective-size">
                  <span>有効な出力寸法</span>
                  <strong>{formatDimensions(geometry.outputSize)}</strong>
                </div>
              </div>

              <div className="metrics-card" aria-label="画像メトリクス">
                <div className="metric-line"><span>元画像</span><strong>{formatDimensions({ width: asset.pixels.width, height: asset.pixels.height })}</strong></div>
                <div className="metric-line"><span>元の容量</span><strong>{formatBytes(asset.file.size)}</strong></div>
                <div className="metric-line"><span>{renderedIsPreview ? '出力プレビュー' : '出力画像'}</span><strong>{metrics ? formatDimensions({ width: metrics.outputWidth, height: metrics.outputHeight }) : '—'}</strong></div>
                <div className="metric-line"><span>出力容量</span><strong>{metrics ? formatBytes(metrics.outputBytes) : '—'}</strong></div>
                <div className="reduction-line"><span>容量の変化</span><strong>{metrics ? `${metrics.reductionPercent >= 0 ? '−' : '+'}${Math.abs(metrics.reductionPercent).toFixed(1)}%` : '—'}</strong></div>
              </div>

              <button className="download-button" type="button" disabled={busy || !renderedResult} onClick={() => void download()}>
                ダウンロード .{getOutputExtension(outputMime)}
              </button>
              <p className="download-hint">ファイル名は安全な形に整えて保存します。</p>
            </aside>
          </section>

          <section className="comparison-section" aria-labelledby="comparison-title">
            <div className="section-heading">
              <div>
                <p className="section-kicker">COMPARE</p>
                <h2 id="comparison-title">変換前と変換後</h2>
              </div>
              <span className="comparison-note">Worker生成プレビュー</span>
            </div>
            <div className="comparison-grid">
              <figure className="comparison-card">
                <figcaption><span>元画像</span><span>{formatDimensions({ width: asset.pixels.width, height: asset.pixels.height })}</span></figcaption>
                <div className="comparison-media"><img src={asset.objectUrl} alt="変換前の元画像" /></div>
              </figure>
              <figure className="comparison-card after-card">
                <figcaption><span>{renderedIsPreview ? '変換後プレビュー' : '変換後'}</span><span>{renderedResult ? formatDimensions({ width: renderedResult.width, height: renderedResult.height }) : '生成中'}</span></figcaption>
                <div className="comparison-media">
                  {renderedUrl ? <img src={renderedUrl} alt="変換後の画像プレビュー" /> : <span className="empty-preview">プレビューを生成しています…</span>}
                </div>
              </figure>
            </div>
          </section>
        </>
      ) : (
        <section className="empty-state" aria-label="画像未選択">
          <p className="empty-number">01</p>
          <h2>まず画像を選択してください。</h2>
          <p>選択後すぐに、切り抜き範囲・ズーム・回転・出力形式を操作できます。</p>
        </section>
      )}

      {errorMessage ? <p className="error-message" role="alert">{errorMessage}</p> : null}

      <footer className="footer-note">
        <div className="footer-facts">
          <span>ローカル処理</span>
          <span aria-hidden="true">·</span>
          <span>メタデータ削除</span>
          <span aria-hidden="true">·</span>
          <span>JPEG / PNG / WebP</span>
        </div>
        <nav className="footer-links" aria-label="外部リンク">
          <a href="https://x.com/big_mon" target="_blank" rel="noopener noreferrer">X @big_mon</a>
          <a href="https://github.com/big-mon/image-compressor-web" target="_blank" rel="noopener noreferrer">GitHub ソースコード</a>
        </nav>
      </footer>
    </main>
  )
}

export default App
