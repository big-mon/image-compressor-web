import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from 'react'

import { isSameResultIntent, type ResultIntent } from './app-async'
import {
  calculateImageGeometry,
  constrainCrop,
  createEditState,
  resizeCropFromBottomRight,
  rotateEditState,
  translateCrop,
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
import {
  createCropSurfaceStyle,
  createStageTransform,
} from './image/stage'

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

type CompositionGuide = 'none' | 'thirds' | 'golden' | 'diagonal'

const COMPOSITION_GUIDE_OPTIONS: readonly { value: CompositionGuide; label: string }[] = [
  { value: 'none', label: 'なし' },
  { value: 'thirds', label: '三分割' },
  { value: 'golden', label: '黄金比' },
  { value: 'diagonal', label: '対角線' },
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
type ComparisonMode = 'original' | 'compare' | 'result'
type ComparisonInspection = 'fit' | 'actual'

interface CropInteraction {
  readonly pointerId: number
  readonly mode: CropInteractionMode
  readonly startX: number
  readonly startY: number
  readonly startEffectiveCrop: CropRect
  readonly displaySize: Size
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
  const [compositionGuide, setCompositionGuide] = useState<CompositionGuide>('thirds')
  const [renderedResult, setRenderedResult] = useState<RasterResult | undefined>()
  const [renderedUrl, setRenderedUrl] = useState('')
  const [renderedIsPreview, setRenderedIsPreview] = useState(true)
  const [quickPreviewResult, setQuickPreviewResult] = useState<RasterResult | undefined>()
  const [fullOutputResult, setFullOutputResult] = useState<RasterResult | undefined>()
  const [candidatePending, setCandidatePending] = useState(false)
  const [previewPending, setPreviewPending] = useState(false)
  const [fullOutputPending, setFullOutputPending] = useState(false)
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('compare')
  const [comparisonSplit, setComparisonSplit] = useState(50)
  const [comparisonInspection, setComparisonInspection] = useState<ComparisonInspection>('fit')
  const [exportPending, setExportPending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [fileError, setFileError] = useState('')
  const [processingError, setProcessingError] = useState('')
  const [processorReady, setProcessorReady] = useState(false)
  const [processorError, setProcessorError] = useState('')
  const processorRef = useRef<RasterProcessor | undefined>(undefined)
  const sourceUrlRef = useRef<string | undefined>(undefined)
  const renderedUrlRef = useRef<string | undefined>(undefined)
  const fileLoadGenerationRef = useRef(0)
  const resultIntentGenerationRef = useRef(0)
  const previewRequestIdRef = useRef(0)
  const fullOutputRequestIdRef = useRef(0)
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
    fullOutputRequestIdRef.current += 1
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

  const quickPreviewMetrics = asset && quickPreviewResult
    ? calculateMetrics({ bytes: asset.file.size }, quickPreviewResult)
    : undefined
  const fullOutputMetrics = asset && fullOutputResult
    ? calculateMetrics({ bytes: asset.file.size }, fullOutputResult)
    : undefined

  const releaseRenderedUrl = () => {
    if (renderedUrlRef.current) {
      URL.revokeObjectURL(renderedUrlRef.current)
      renderedUrlRef.current = undefined
    }
    setRenderedUrl('')
    setRenderedResult(undefined)
    setRenderedIsPreview(true)
    setQuickPreviewResult(undefined)
    setFullOutputResult(undefined)
    setComparisonInspection('fit')
  }

  const cancelExport = () => {
    exportRequestIdRef.current += 1
    exportActiveRef.current = undefined
    setExportPending(false)
  }

  const cancelFullOutput = () => {
    fullOutputRequestIdRef.current += 1
    setFullOutputPending(false)
  }

  const invalidatePreview = () => {
    invalidateResultIntent()
    cancelExport()
    cancelFullOutput()
    releaseRenderedUrl()
    setPreviewPending(true)
    setFileError('')
    setProcessingError('')
  }

  const beginFileSelection = () => {
    cancelExport()
    cancelFullOutput()
    setCandidatePending(true)
    setFileError('')
    setProcessingError('')
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
      setProcessorError('')
      setProcessorReady(true)
    } catch (error) {
      const message = getErrorMessage(error, '画像処理ワーカーを起動できませんでした。')
      setProcessorError(message)
      setProcessingError(message)
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
    if (!asset || !editState || !geometry) {
      return undefined
    }
    if (!processorReady) {
      if (processorError) {
        setPreviewPending(false)
        setProcessingError(processorError)
      }
      return undefined
    }
    const processor = processorRef.current
    if (!processor) {
      setPreviewPending(false)
      setProcessingError(processorError || '画像処理ワーカーを起動できませんでした。')
      return undefined
    }

    const intentGeneration = resultIntentGenerationRef.current
    if (exportActiveRef.current?.intentGeneration === intentGeneration) {
      return undefined
    }

    const requestId = ++previewRequestIdRef.current
    setPreviewPending(true)
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
          setQuickPreviewResult(result)
          adoptRenderedResult(result, true)
          setPreviewPending(false)
        })
        .catch((error: unknown) => {
          if (
            previewRequestIdRef.current !== requestId ||
            resultIntentGenerationRef.current !== intentGeneration
          ) {
            return
          }
          setPreviewPending(false)
          if (exportActiveRef.current?.intentGeneration !== intentGeneration) {
            setProcessingError(getErrorMessage(error, 'プレビューを生成できませんでした。'))
          }
        })
    }, 160)

    return () => window.clearTimeout(timeoutId)
  }, [asset, editState, geometry, outputMime, processorError, processorReady, quality])

  const confirmFullOutput = async () => {
    if (
      !asset ||
      !editState ||
      !processorRef.current ||
      candidatePending ||
      previewPending ||
      exportPending ||
      fullOutputPending ||
      fullOutputResult
    ) {
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
    const requestId = ++fullOutputRequestIdRef.current
    setFullOutputPending(true)
    setProcessingError('')

    try {
      const result = await processor.process(asset.pixels, editState, {
        mimeType: outputMime,
        quality,
        preview: false,
      })
      const isCurrent = fullOutputRequestIdRef.current === requestId &&
        resultIntentGenerationRef.current === intentGeneration &&
        isSameResultIntent(currentIntentRef.current, expectedIntent)
      if (!isCurrent) {
        return
      }
      setFullOutputResult(result)
      adoptRenderedResult(result, false)
    } catch (error) {
      const isCurrent = fullOutputRequestIdRef.current === requestId &&
        resultIntentGenerationRef.current === intentGeneration &&
        isSameResultIntent(currentIntentRef.current, expectedIntent)
      if (isCurrent) {
        setProcessingError(getErrorMessage(error, '保存用画像を確認できませんでした。'))
      }
    } finally {
      if (fullOutputRequestIdRef.current === requestId) {
        setFullOutputPending(false)
      }
    }
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) {
      return
    }
    const loadGeneration = ++fileLoadGenerationRef.current
    beginFileSelection()
    const mimeType = file.type.toLowerCase()
    if (!isSupportedImageMimeType(mimeType)) {
      setCandidatePending(false)
      setFileError('JPEG、PNG、WebP の画像だけを選択してください。')
      return
    }

    try {
      const pixels = await decodeImageFile(file)
      if (fileLoadGenerationRef.current !== loadGeneration) {
        return
      }
      const objectUrl = URL.createObjectURL(file)
      try {
        invalidateResultIntent()
        processorRef.current?.clearSource()
      } catch (error) {
        URL.revokeObjectURL(objectUrl)
        setCandidatePending(false)
        setPreviewPending(false)
        setProcessingError(getErrorMessage(error, '画像処理を新しい画像へ切り替えられませんでした。'))
        return
      }
      releaseRenderedUrl()
      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current)
      }
      sourceUrlRef.current = objectUrl
      setAsset({ file, pixels, objectUrl })
      setEditState(createEditState({ width: pixels.width, height: pixels.height }))
      setCandidatePending(false)
      setFileError('')
      if (!processorRef.current) {
        setPreviewPending(false)
        setProcessingError(processorError || '画像処理ワーカーを起動できませんでした。')
      } else {
        setPreviewPending(true)
        setProcessingError('')
      }
    } catch (error) {
      if (fileLoadGenerationRef.current !== loadGeneration) {
        return
      }
      setCandidatePending(false)
      setFileError(getErrorMessage(error, '画像を読み込めませんでした。'))
    }
  }

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    void handleFile(event.target.files?.[0])
    event.target.value = ''
  }

  const handleDragOver = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = () => {
    setDragging(false)
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
    setCandidatePending(false)
    invalidatePreview()
    try {
      processorRef.current?.clearSource()
    } catch (error) {
      setPreviewPending(false)
      setProcessingError(getErrorMessage(error, '画像処理をリセットできませんでした。'))
    }
    setEditState(createEditState({ width: asset.pixels.width, height: asset.pixels.height }))
  }

  const updateEditState = (update: (current: ImageEditState) => ImageEditState) => {
    invalidatePreview()
    setEditState((current) => current ? update(current) : current)
  }

  const updateOutputMime = (nextOutputMime: OutputMime) => {
    if (nextOutputMime === outputMime) {
      return
    }
    invalidatePreview()
    setOutputMime(nextOutputMime)
  }

  const updateQuality = (nextQuality: number) => {
    if (nextQuality === quality) {
      return
    }
    invalidatePreview()
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
      const minimum = field === 'x' || field === 'y' ? 0 : 1
      const nextCrop = { ...geometry.crop, [field]: Math.max(minimum, value) }
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
      startEffectiveCrop: geometry.crop,
      displaySize: geometry.displaySize,
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
        crop: resizeCropFromBottomRight(
          interaction.startEffectiveCrop,
          { x: deltaX, y: deltaY },
          interaction.displaySize,
          current.aspectRatio,
        ),
        zoom: 1,
        panX: 0,
        panY: 0,
      }))
      return
    }

    updateEditState((current) => ({
      ...current,
      crop: translateCrop(
        interaction.startEffectiveCrop,
        { x: deltaX, y: deltaY },
        interaction.displaySize,
        current.aspectRatio,
      ),
      zoom: 1,
      panX: 0,
      panY: 0,
    }))
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
      crop: translateCrop(geometry.crop, delta, geometry.displaySize, current.aspectRatio),
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
    setExportPending(true)
    setProcessingError('')
    const output = { mimeType: outputMime, quality, preview: false }

    try {
      const result = fullOutputResult ?? await processor.process(asset.pixels, editState, output)
      const isCurrent = exportActiveRef.current?.requestId === requestId &&
        resultIntentGenerationRef.current === intentGeneration &&
        isSameResultIntent(currentIntentRef.current, expectedIntent)
      if (!isCurrent) {
        return
      }
      setFullOutputResult(result)
      const downloadUrl = adoptRenderedResult(result, false)
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = sanitizeDownloadFilename(asset.file.name, outputMime)
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setPreviewPending(false)
    } catch (error) {
      const isCurrent = exportActiveRef.current?.requestId === requestId &&
        resultIntentGenerationRef.current === intentGeneration &&
        isSameResultIntent(currentIntentRef.current, expectedIntent)
      if (isCurrent) {
        setPreviewPending(false)
        setProcessingError(getErrorMessage(error, 'ダウンロード用の画像を生成できませんでした。'))
      }
    } finally {
      if (exportActiveRef.current?.requestId === requestId) {
        exportActiveRef.current = undefined
        setExportPending(false)
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
  const cropSurfaceStyle: CSSProperties | undefined = geometry
    ? createCropSurfaceStyle(geometry.displaySize)
    : undefined
  const comparisonAvailable = Boolean(renderedUrl && renderedResult)
  const errorMessage = fileError || processingError || processorError
  const busy = candidatePending || previewPending || fullOutputPending || exportPending
  const comparisonFrameStyle: CSSProperties | undefined = geometry
    ? {
        aspectRatio: `${geometry.crop.width} / ${geometry.crop.height}`,
        maxWidth: `min(56rem, calc(38rem * ${geometry.crop.width / geometry.crop.height}))`,
      }
    : undefined
  const actualInspectionAvailable = comparisonAvailable && !renderedIsPreview && fullOutputResult !== undefined && renderedResult !== undefined
  const comparisonViewportStyle: CSSProperties | undefined = actualInspectionAvailable && comparisonInspection === 'actual'
    ? { height: 'min(38rem, 70vh)' }
    : comparisonFrameStyle
  const comparisonCanvasStyle: CSSProperties | undefined = actualInspectionAvailable && comparisonInspection === 'actual' && renderedResult
    ? {
        width: `${renderedResult.width}px`,
        height: `${renderedResult.height}px`,
      }
    : undefined
  const comparisonSourceCanvasStyle: CSSProperties | undefined = geometry
    ? {
        left: `${-currentCrop.x / currentCrop.width * 100}%`,
        top: `${-currentCrop.y / currentCrop.height * 100}%`,
        width: `${geometry.displaySize.width / currentCrop.width * 100}%`,
        height: `${geometry.displaySize.height / currentCrop.height * 100}%`,
      }
    : undefined

  return (
    <>
      <main className="shell">
        <header className="tool-toolbar">
          <div className="toolbar-copy">
            <h1>画像を圧縮・編集</h1>
            <p className="tool-reassurance">画像は外部に送信されません</p>
          </div>
          <input
            id="image-input"
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            tabIndex={-1}
            aria-label="画像ファイルを選択"
            onChange={handleInputChange}
          />
          <div className="toolbar-actions">
            {asset ? (
              <span className={`status-chip${busy ? ' is-busy' : ''}`} role="status" aria-live="polite">
                {busy
                  ? fileError
                    ? 'エラー'
                    : candidatePending
                      ? '画像を読み込み中…'
                      : fullOutputPending
                        ? '保存用画像を確認中…'
                      : previewPending
                        ? '圧縮プレビューを更新中…'
                        : '処理中…'
                  : errorMessage
                    ? 'エラー'
                    : renderedResult
                      ? 'プレビュー準備完了'
                      : '画像を準備中'}
              </span>
            ) : null}
            {asset ? (
              <label
                className={`change-image-button${dragging ? ' is-dragging' : ''}`}
                htmlFor="image-input"
                role="button"
                tabIndex={0}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    document.getElementById('image-input')?.click()
                  }
                }}
              >
                画像を変更
              </label>
            ) : null}
          </div>
        </header>

        {asset && editState && geometry ? (
          <>
            <section className="workspace" aria-label="画像エディター">
              <div className="editor-column">
                <div className="crop-editor-heading">
                  <div>
                    <p className="section-kicker">EDIT</p>
                    <h2>切り抜き範囲</h2>
                  </div>
                  <p className="crop-guidance">枠内が残る範囲です。暗い外側は削除されます。</p>
                </div>
                <div className="stage-area" aria-label="画像編集ステージ">
                  <div
                    ref={cropSurfaceRef}
                    className="crop-surface"
                    style={cropSurfaceStyle}
                    onPointerMove={moveCropInteraction}
                    onPointerUp={endCropInteraction}
                    onPointerCancel={endCropInteraction}
                  >
                    <div className="crop-image-layer">
                      <img
                        className="stage-image"
                        src={asset.objectUrl}
                        alt={`${asset.file.name} の編集対象`}
                        draggable={false}
                        style={stageImageStyle}
                      />
                      <div className="crop-shade crop-shade-top" style={{ height: cropStyle?.top }} />
                      <div className="crop-shade crop-shade-bottom" style={{ height: geometry ? `${Math.max(0, geometry.displaySize.height - currentCrop.y - currentCrop.height) / geometry.displaySize.height * 100}%` : undefined }} />
                      <div className="crop-shade crop-shade-left" style={{ top: cropStyle?.top, width: cropStyle?.left, height: cropStyle?.height }} />
                      <div className="crop-shade crop-shade-right" style={{ top: cropStyle?.top, width: geometry ? `${Math.max(0, geometry.displaySize.width - currentCrop.x - currentCrop.width) / geometry.displaySize.width * 100}%` : undefined, height: cropStyle?.height }} />
                    </div>
                    <div
                      className="crop-rectangle"
                      style={cropStyle}
                      role="group"
                      tabIndex={0}
                      aria-label="切り抜き範囲。矢印キーで移動、Shiftで大きく移動"
                      onKeyDown={moveCropWithKeyboard}
                      onPointerDown={(event) => beginCropInteraction(event, 'move')}
                    >
                      {compositionGuide === 'diagonal' ? (
                        <svg className="crop-guide crop-guide-diagonal" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                          <line x1="0" y1="0" x2="100" y2="100" />
                          <line x1="0" y1="100" x2="100" y2="0" />
                        </svg>
                      ) : (
                        <span className={`crop-guide${compositionGuide === 'thirds' || compositionGuide === 'golden' ? ' crop-grid' : ''} crop-guide-${compositionGuide}`} aria-hidden="true" />
                      )}
                      <button
                        className="crop-handle"
                        type="button"
                        aria-label="右下のハンドル。左上を固定して切り抜き範囲をリサイズ"
                        onPointerDown={(event) => beginCropInteraction(event, 'resize')}
                      />
                    </div>
                  </div>
                </div>

                <div className="crop-stage-meta" aria-live="polite">
                  <span className="stage-preview-label">元画像（切り抜き編集）</span>
                  <span className="crop-processing-status">
                    {candidatePending
                      ? '新しい画像を読み込み中…'
                      : previewPending
                        ? 'プレビュー更新中。切り抜きはそのまま操作できます。'
                        : errorMessage
                          ? '結果を更新できませんでした。元画像の編集は続けられます。'
                          : '画像上の枠をドラッグして位置を調整できます。'}
                  </span>
                </div>

                <div className="button-row editor-actions">
                  <button type="button" className="secondary-button" onClick={() => rotateBy(-90)}>↺ 左へ90°</button>
                  <button type="button" className="secondary-button" onClick={() => rotateBy(90)}>↻ 右へ90°</button>
                  <button type="button" className={`secondary-button${editState.flipHorizontal ? ' is-selected' : ''}`} onClick={() => updateEditState((current) => ({ ...current, flipHorizontal: !current.flipHorizontal }))}>↔ 左右反転</button>
                  <button type="button" className={`secondary-button${editState.flipVertical ? ' is-selected' : ''}`} onClick={() => updateEditState((current) => ({ ...current, flipVertical: !current.flipVertical }))}>↕ 上下反転</button>
                  <button type="button" className="text-button" onClick={resetEdits}>編集をリセット</button>
                  <div className="guide-control">
                    <label htmlFor="composition-guide">構図補助線</label>
                    <select id="composition-guide" value={compositionGuide} onChange={(event) => setCompositionGuide(event.target.value as CompositionGuide)}>
                      {COMPOSITION_GUIDE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                </div>

                <section className="comparison-section" aria-labelledby="comparison-heading">
                  <div className="section-heading comparison-heading">
                    <div>
                      <p className="section-kicker">COMPARE</p>
                      <h2 id="comparison-heading">仕上がりを確認</h2>
                    </div>
                    <p className="comparison-guidance">元画像と結果を同じ切り抜き位置で見比べます。</p>
                  </div>

                  <div className={`comparison-card comparison-mode-${comparisonMode}`}>
                    <div
                      className={`comparison-viewport${actualInspectionAvailable && comparisonInspection === 'actual' ? ' is-actual' : ''}`}
                      style={comparisonViewportStyle}
                      tabIndex={0}
                      aria-label="元画像と出力結果の比較表示"
                    >
                      <div className={`comparison-canvas${actualInspectionAvailable && comparisonInspection === 'actual' ? ' is-actual' : ''}`} style={comparisonCanvasStyle}>
                        <div
                          className="comparison-layer comparison-original-layer"
                          style={comparisonMode === 'compare'
                            ? { clipPath: `inset(0 ${100 - comparisonSplit}% 0 0)` }
                            : comparisonMode === 'result'
                              ? { visibility: 'hidden' }
                              : undefined}
                          aria-hidden={comparisonMode === 'result'}
                        >
                          <div className="comparison-source-canvas" style={comparisonSourceCanvasStyle}>
                            <img
                              className="comparison-original-image"
                              src={asset.objectUrl}
                              alt="元画像の切り抜き・変換後フレーム"
                              draggable={false}
                              style={stageImageStyle}
                            />
                          </div>
                          <span className="comparison-layer-label">元画像</span>
                        </div>

                        <div
                          className="comparison-layer comparison-result-layer"
                          style={comparisonMode === 'original' ? { visibility: 'hidden' } : undefined}
                          aria-hidden={comparisonMode === 'original'}
                        >
                          {comparisonAvailable ? (
                            <img
                              className="processed-preview comparison-result-image"
                              src={renderedUrl}
                              alt="圧縮後の出力結果"
                              draggable={false}
                              data-preview-kind={renderedIsPreview ? 'quick' : 'full'}
                              data-output-width={renderedResult?.width}
                              data-output-height={renderedResult?.height}
                              data-output-bytes={renderedResult?.bytes}
                            />
                          ) : null}
                          {comparisonAvailable ? (
                            <span className="comparison-layer-label comparison-result-label">
                              {renderedIsPreview ? 'クイック確認' : '保存用画像'}
                            </span>
                          ) : null}
                        </div>

                        {comparisonMode === 'compare' && comparisonAvailable ? (
                          <div className="comparison-divider" style={{ left: `${comparisonSplit}%` }} aria-hidden="true" />
                        ) : null}
                        {!comparisonAvailable ? (
                          <div className="comparison-empty" role="status" aria-live="polite">
                            {previewPending || fullOutputPending
                              ? '出力結果を更新中…'
                              : errorMessage
                                ? '出力結果を表示できません。元画像で編集できます。'
                                : '出力結果を準備しています…'}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="comparison-mode-buttons" role="group" aria-label="比較表示モード">
                      <button
                        className={`comparison-mode-button${comparisonMode === 'original' ? ' is-selected' : ''}`}
                        type="button"
                        data-comparison-mode="original"
                        aria-pressed={comparisonMode === 'original'}
                        onClick={() => setComparisonMode('original')}
                      >
                        元画像
                      </button>
                      <button
                        className={`comparison-mode-button${comparisonMode === 'compare' ? ' is-selected' : ''}`}
                        type="button"
                        data-comparison-mode="compare"
                        aria-pressed={comparisonMode === 'compare'}
                        onClick={() => setComparisonMode('compare')}
                      >
                        比較
                      </button>
                      <button
                        className={`comparison-mode-button${comparisonMode === 'result' ? ' is-selected' : ''}`}
                        type="button"
                        data-comparison-mode="result"
                        disabled={!comparisonAvailable}
                        aria-pressed={comparisonMode === 'result'}
                        onClick={() => setComparisonMode('result')}
                      >
                        出力結果
                      </button>
                    </div>

                    {outputMime === 'image/png' ? (
                      <p className="comparison-quality-note">PNGでは保存画質の設定はありません。</p>
                    ) : (
                      <div className="range-control comparison-quality-control">
                        <div className="range-label"><label htmlFor="quality">保存画質</label><output htmlFor="quality">{Math.round(quality * 100)}%</output></div>
                        <input id="quality" type="range" min="0.01" max="1" step="0.01" value={quality} aria-describedby="quality-help" onChange={(event) => updateQuality(Number(event.target.value))} />
                        <span id="quality-help" className="field-help">JPEG・WebPのエンコード設定。劣化率ではありません。</span>
                      </div>
                    )}

                    <div className="range-control comparison-split-control">
                      <div className="range-label">
                        <label htmlFor="comparison-split">比較の境界</label>
                        <output htmlFor="comparison-split">{comparisonSplit}% 元画像</output>
                      </div>
                      <input
                        id="comparison-split"
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={comparisonSplit}
                        disabled={!comparisonAvailable || comparisonMode !== 'compare'}
                        aria-label="元画像と出力結果の比較境界。0は出力結果のみ、100は元画像のみ"
                        onChange={(event) => setComparisonSplit(Number(event.target.value))}
                      />
                      <div className="comparison-endpoints" aria-hidden="true"><span>出力結果</span><span>元画像</span></div>
                    </div>

                    <div className="comparison-inspection-controls" role="group" aria-label="比較画像の表示倍率">
                      <span className="field-label">表示</span>
                      <button
                        className={`comparison-inspection-button${comparisonInspection === 'fit' ? ' is-selected' : ''}`}
                        type="button"
                        aria-pressed={comparisonInspection === 'fit'}
                        onClick={() => setComparisonInspection('fit')}
                      >
                        全体表示
                      </button>
                      <button
                        className={`comparison-inspection-button${comparisonInspection === 'actual' ? ' is-selected' : ''}`}
                        type="button"
                        disabled={!actualInspectionAvailable}
                        aria-pressed={comparisonInspection === 'actual'}
                        onClick={() => setComparisonInspection('actual')}
                      >
                        100%表示
                      </button>
                      <span className="field-help">100%表示は保存用画像の1pxを画面の1pxで確認します。必要に応じてスクロールできます。</span>
                    </div>

                    <div className="comparison-footer">
                      <p className="comparison-status">
                        {comparisonAvailable
                          ? renderedIsPreview
                            ? 'クイック確認：最大960pxに縮小した確認用です。容量もこの確認用画像の値です。'
                            : '保存用画像：実際に保存される解像度・エンコード結果を確認しています。'
                          : '結果がない間も、上の元画像で切り抜き範囲を操作できます。'}
                      </p>
                      <button
                        className="verify-output-button"
                        type="button"
                        disabled={!processorReady || candidatePending || previewPending || exportPending || fullOutputPending || Boolean(fullOutputResult)}
                        onClick={() => void confirmFullOutput()}
                      >
                        {fullOutputPending
                          ? '保存サイズを確認中…'
                          : fullOutputResult
                            ? '保存サイズを確認済み'
                            : '保存サイズを確認（フルサイズ）'}
                      </button>
                    </div>
                  </div>
                </section>
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

                  <div className="resize-fields">
                    <div className="field-label-row"><span className="field-label">出力サイズ</span><span className="field-help">幅または高さ</span></div>
                    <label htmlFor="resize-width">幅<input id="resize-width" type="number" min="1" step="1" placeholder="自動" value={editState.resize?.width ?? ''} onChange={(event) => updateResize('width', event.target.value)} /></label>
                    <label htmlFor="resize-height">高さ<input id="resize-height" type="number" min="1" step="1" placeholder="自動" value={editState.resize?.height ?? ''} onChange={(event) => updateResize('height', event.target.value)} /></label>
                  </div>
                  <div className="aspect-ratio-control">
                    <div className="field-label-row"><label className="field-label" htmlFor="aspect-ratio">アスペクト比</label><span className="field-help">切り抜き範囲に適用</span></div>
                    <select id="aspect-ratio" value={editState.aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatioPreset)}>
                      {ASPECT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  <div className="effective-size">
                    <span>有効な出力寸法</span>
                    <strong>{formatDimensions(geometry.outputSize)}</strong>
                  </div>
                </div>

                <button className="download-button" type="button" disabled={busy || !renderedResult} onClick={() => void download()}>
                  ダウンロード .{getOutputExtension(outputMime)}
                </button>
                <p className="download-hint">ファイル名は安全な形に整えて保存します。</p>

                <div className="metrics-card" aria-label="画像メトリクス">
                  <div className="metric-line"><span>元画像</span><strong>{formatDimensions({ width: asset.pixels.width, height: asset.pixels.height })}</strong></div>
                  <div className="metric-line"><span>元の容量</span><strong>{formatBytes(asset.file.size)}</strong></div>
                  <div className="metric-line quick-preview-metrics"><span>クイックプレビュー寸法（最大960px）</span><strong className="quick-preview-dimensions">{quickPreviewMetrics ? formatDimensions({ width: quickPreviewMetrics.outputWidth, height: quickPreviewMetrics.outputHeight }) : '未生成'}</strong></div>
                  <div className="metric-line quick-preview-bytes"><span>クイックプレビュー容量</span><strong className="quick-preview-bytes-value">{quickPreviewMetrics ? formatBytes(quickPreviewMetrics.outputBytes) : '未生成'}</strong></div>
                  <div className="metric-line full-output-metrics"><span>保存用画像寸法</span><strong className="full-output-dimensions">{fullOutputMetrics ? formatDimensions({ width: fullOutputMetrics.outputWidth, height: fullOutputMetrics.outputHeight }) : '未確認'}</strong></div>
                  <div className="metric-line full-output-bytes"><span>保存用画像容量</span><strong className="full-output-bytes-value">{fullOutputMetrics ? formatBytes(fullOutputMetrics.outputBytes) : '未確認'}</strong></div>
                  <div className="reduction-line"><span>容量の変化（保存用画像）</span><strong>{fullOutputMetrics ? `${fullOutputMetrics.reductionPercent >= 0 ? '−' : '+'}${Math.abs(fullOutputMetrics.reductionPercent).toFixed(1)}%` : '未確認'}</strong></div>
                </div>

              </aside>
            </section>

            <details className="advanced-controls">
              <summary>詳細な切り抜き・位置調整</summary>
              <div className="advanced-controls-body">
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

              </div>
            </details>
          </>
        ) : (
          <label
            className={`drop-zone${dragging ? ' is-dragging' : ''}`}
            htmlFor="image-input"
            role="button"
            tabIndex={0}
            aria-controls="image-input"
            aria-describedby="drop-detail"
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                document.getElementById('image-input')?.click()
              }
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <span className="drop-icon" aria-hidden="true">＋</span>
            <span className="drop-title">画像を選択またはドロップ</span>
            <span id="drop-detail" className="drop-detail">JPEG・PNG・WebPの静止画に対応</span>
          </label>
        )}

        {errorMessage ? <p className="error-message" role="alert">{errorMessage}</p> : null}

        <details className="privacy-details">
          <summary>処理とプライバシーについて</summary>
          <div className="privacy-details-body">
            <p>すべての処理はこのブラウザ内で完結します。ピクセルにデコードしてから再エンコードするため、出力画像のメタデータは削除されます。JPEGの回転もロスレス変換ではなく再エンコードです。</p>
          </div>
        </details>
      </main>

      <footer className="site-footer">
        <div className="footer-inner">
          <nav className="footer-links" aria-label="フッターナビゲーション">
            <a href="/">App Hubへ戻る</a>
            <a href="https://x.com/big_mon" target="_blank" rel="noopener noreferrer">X @big_mon</a>
            <a href="https://github.com/big-mon/image-compressor-web" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href={`${import.meta.env.BASE_URL}guide.html`}>使い方ガイド</a>
          </nav>
          <span>© 2026 image-compressor-web</span>
        </div>
      </footer>
    </>
  )
}

export default App
