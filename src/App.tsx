import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from 'react'

import { isSameResultIntent, type ResultIntent } from './app-async'
import {
  calculateImageGeometry,
  constrainCrop,
  createEditState,
  resizeCropFromCorner,
  type CropCorner,
  rotateEditState,
  straightenEditState,
  translateCrop,
  type AspectRatioPreset,
  type CropRect,
  type ImageEditState,
  type CropBounds,
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
  zoomView,
  placeCropHandle,
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

const CROP_CORNERS: readonly CropCorner[] = ['bottom-right', 'bottom-left', 'top-left', 'top-right']
const CORNER_LABELS = { 'bottom-right': '右下', 'bottom-left': '左下', 'top-left': '左上', 'top-right': '右上' }
type CropInteractionMode = 'move' | 'resize'

interface CropInteraction {
  readonly pointerId: number
  readonly corner: CropCorner
  readonly mode: CropInteractionMode
  readonly startX: number
  readonly startY: number
  readonly startEffectiveCrop: CropRect
  readonly displaySize: CropBounds
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function App() {
  const [asset, setAsset] = useState<SourceAsset | undefined>()
  const [editState, setEditState] = useState<ImageEditState | undefined>()
  const [outputMime, setOutputMime] = useState<OutputMime>('image/jpeg')
  const [quality, setQuality] = useState(0.82)
  const [editorMode, setEditorMode] = useState<'crop' | 'transform' | 'compress'>('compress')
  const editorView = editorMode === 'compress' ? 'compare' : 'edit'
  const outputOpen = editorMode === 'compress'
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const editorRef = useRef<HTMLDivElement>(null)
  const spaceHeld = useRef(false)
  const spacePanned = useRef(false)
  const spaceSelect = useRef<HTMLSelectElement | null>(null)
  const panStart = useRef<{ pointerId: number; x: number; y: number; viewX: number; viewY: number } | null>(null)
  const compressionTabRef = useRef<HTMLButtonElement>(null)
  const editChangedAtRef = useRef(0)
  const [renderedResult, setRenderedResult] = useState<RasterResult | undefined>()
  const [renderedUrl, setRenderedUrl] = useState('')
  const [renderedIsPreview, setRenderedIsPreview] = useState(true)
  const [quickPreviewResult, setQuickPreviewResult] = useState<RasterResult | undefined>()
  const [fullOutputResult, setFullOutputResult] = useState<RasterResult | undefined>()
  const [candidatePending, setCandidatePending] = useState(false)
  const [previewPending, setPreviewPending] = useState(false)
  const [fullOutputPending, setFullOutputPending] = useState(false)
  const [comparisonSplit, setComparisonSplit] = useState(50)
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
  const comparisonInputRef = useRef<HTMLInputElement>(null)
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
    editChangedAtRef.current = performance.now()
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

  const confirmFullOutput = useCallback(async () => {
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
  }, [asset, editState, outputMime, quality, candidatePending, previewPending, exportPending, fullOutputPending, fullOutputResult])

  useEffect(() => {
    // ponytail: started full encodes remain active; Worker restart is needed for preemption.
    if (!outputOpen || !quickPreviewResult || processingError || candidatePending || previewPending || exportPending || fullOutputPending || fullOutputResult) {
      return
    }
    const timeout = window.setTimeout(() => {
      void confirmFullOutput()
    }, Math.max(0, 600 - (performance.now() - editChangedAtRef.current)))
    return () => window.clearTimeout(timeout)
  }, [outputOpen, confirmFullOutput, quickPreviewResult, processingError, candidatePending, previewPending, exportPending, fullOutputPending, fullOutputResult])

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
      setEditorMode('compress')
      setView({ zoom: 1, x: 0, y: 0 })
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
    corner: CropCorner = 'bottom-right',
  ) => {
    if (!editState || !geometry || !cropSurfaceRef.current) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    cropSurfaceRef.current.setPointerCapture(event.pointerId)
    cropInteractionRef.current = {
      pointerId: event.pointerId,
      corner,
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
        crop: resizeCropFromCorner(
          interaction.startEffectiveCrop,
          { x: deltaX, y: deltaY },
          interaction.displaySize,
          current.aspectRatio,
          interaction.corner,
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

  const editCropWithKeyboard = (event: React.KeyboardEvent<HTMLElement>, mode: CropInteractionMode, corner: CropCorner = 'bottom-right') => {
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
    event.stopPropagation()
    updateEditState((current) => {
      // Follow the ratio in both axes so projection preserves the pressed axis's step.
      const sign = (corner.endsWith('left') ? -1 : 1) * (corner.startsWith('top') ? -1 : 1)
      const resizeDelta = current.aspectRatio === 'free' ? delta : delta.x !== 0
        ? { x: delta.x, y: delta.x * geometry.crop.height / geometry.crop.width * sign }
        : { x: delta.y * geometry.crop.width / geometry.crop.height * sign, y: delta.y }
      return {
        ...current,
        crop: mode === 'resize'
          ? resizeCropFromCorner(geometry.crop, resizeDelta, geometry.displaySize, current.aspectRatio, corner)
          : translateCrop(geometry.crop, delta, geometry.displaySize, current.aspectRatio),
        zoom: 1,
        panX: 0,
        panY: 0,
      }
    })
  }

  const moveComparisonBoundary = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width > 0) {
      setComparisonSplit(Math.round(Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100))))
    }
  }

  const endComparisonDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
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
        transform: createStageTransform(editState.rotation, editState.flipHorizontal, editState.flipVertical, geometry.straightening),
      }
    : undefined
  const cropSurfaceStyle: CSSProperties | undefined = geometry
    ? { width: geometry.displaySize.width * view.zoom, height: geometry.displaySize.height * view.zoom, transform: `translate(${view.x}px, ${view.y}px)` }
    : undefined
  const comparisonAvailable = Boolean(renderedUrl && renderedResult)
  const errorMessage = fileError || processingError || processorError
  const busy = candidatePending || previewPending || fullOutputPending || exportPending
  const comparisonFrameStyle: CSSProperties | undefined = geometry
    ? {
        width: geometry.crop.width * view.zoom,
        height: geometry.crop.height * view.zoom,
        transform: `translate(${view.x}px, ${view.y}px)`,
      }
    : undefined
  useLayoutEffect(() => {
    if (!geometry || editorView !== 'edit') return
    const stage = cropSurfaceRef.current?.closest('.stage-area')
    const crop = stage?.querySelector<HTMLElement>('.crop-rectangle')
    const handles = [...(stage?.querySelectorAll<HTMLButtonElement>('.crop-handle') ?? [])]
    const shell = stage?.closest('.editor-shell')
    if (!stage || !crop || !handles.length || !shell) return
    const controls = [...shell.querySelectorAll<HTMLElement>('.image-actions,.zoom-controls,.editor-bottom,.error-message')]
    const placeHandle = () => {
      const frame = stage.getBoundingClientRect()
      const bounds = crop.getBoundingClientRect()
      const obstacles = [new DOMRect(bounds.x + bounds.width / 2 - 12, bounds.y + bounds.height / 2 - 12, 24, 24), ...controls.map(control => control.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0)]
      for (const handle of handles) {
        const size = handle.getBoundingClientRect().width
        const corner = handle.dataset.corner as CropCorner
        const position = placeCropHandle(
          { x: corner.endsWith('left') ? bounds.left + size : bounds.right, y: corner.startsWith('top') ? bounds.top + size : bounds.bottom },
          { width: frame.width, height: frame.height }, size, obstacles,
        )
        handle.style.left = `${position.left}px`
        handle.style.top = `${position.top}px`
        obstacles.push(new DOMRect(position.left, position.top, size, size))
      }
    }
    placeHandle()
    const observer = new ResizeObserver(placeHandle)
    for (const element of [shell, stage, crop, ...controls]) observer.observe(element)
    return () => observer.disconnect()
  }, [geometry, editorView, editorMode, outputOpen, errorMessage, view])
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? editor.clientHeight : 1)
      setView(current => zoomView(current, delta, { x: event.clientX - editor.clientWidth / 2, y: event.clientY - editor.clientHeight / 2 }))
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        spaceHeld.current = true
        if (!event.repeat) spacePanned.current = false
        // Defer the native popup until release; preserve native selection without this API.
        if (event.target instanceof HTMLSelectElement && typeof event.target.showPicker === 'function' && window.top === window) {
          event.preventDefault()
          spaceSelect.current = event.target
        } else if (event.target === document.body || event.target === document.documentElement) {
          event.preventDefault()
        }
      }
      if (outputOpen && event.key === 'Escape') {
        event.preventDefault()
        setEditorMode('crop')
        compressionTabRef.current?.focus()
      }
    }
    const keyUp = (event: KeyboardEvent) => {
      if (event.key !== ' ') return
      spaceHeld.current = false
      const select = spaceSelect.current
      spaceSelect.current = null
      if (spacePanned.current) {
        event.preventDefault()
        event.stopPropagation()
      } else if (select && document.activeElement === select) {
        event.preventDefault()
        try { select.showPicker() } catch {
          // Native arrow-key selection remains available if activation expired.
        }
      }
    }
    const releaseSpace = (event: Event) => {
      if (event.type === 'blur') {
        spaceHeld.current = false
        panStart.current = null
      }
      if (event.type === 'blur' || event.target === spaceSelect.current) spaceSelect.current = null
    }
    editor.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('keydown', keyDown, true)
    window.addEventListener('keyup', keyUp, true)
    window.addEventListener('blur', releaseSpace)
    window.addEventListener('focusout', releaseSpace)
    return () => {
      editor.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', keyDown, true)
      window.removeEventListener('keyup', keyUp, true)
      window.removeEventListener('blur', releaseSpace)
      window.removeEventListener('focusout', releaseSpace)
    }
  }, [asset, outputOpen])

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
      <main className={asset ? 'shell editor-shell' : 'shell'}>
          <input
            id="image-input"
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            tabIndex={-1}
            aria-label="画像ファイルを選択"
            onChange={handleInputChange}
          />
        {!asset ? <header className="tool-toolbar"><div className="toolbar-copy"><h1>画像を圧縮・編集</h1><p className="tool-reassurance">画像は外部に送信されません</p></div></header> : <div className="image-actions" role="group" aria-label="画像の操作">
            <h1 className="visually-hidden">画像を圧縮・編集</h1>
              <label
                className={`change-image-button${dragging ? ' is-dragging' : ''}`}
                htmlFor="image-input"
                role="button"
                aria-label="画像を変更"
                title="画像を変更"
                tabIndex={0}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onKeyDown={(event) => {
                  if (event.key === ' ') event.preventDefault()
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    document.getElementById('image-input')?.click()
                  }
                }}
                onKeyUp={event => {
                  if (event.key === ' ') {
                    event.preventDefault()
                    document.getElementById('image-input')?.click()
                  }
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </label>
        </div>}
        {asset && editState && geometry ? <>
          <div className="zoom-controls" role="group" aria-label="表示倍率">
            <button type="button" aria-label="縮小" title="縮小" disabled={view.zoom <= 0.01} onClick={() => setView(current => zoomView(current, 100, { x: 0, y: 0 }))}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
            </button>
            <output aria-label="現在の拡大率">{Math.round(view.zoom * 100)}%</output>
            <button type="button" aria-label="拡大" title="拡大" disabled={view.zoom >= 16} onClick={() => setView(current => zoomView(current, -100, { x: 0, y: 0 }))}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14" /></svg>
            </button>
          </div>
          <section className="workspace" aria-label="画像エディター" data-quick-width={quickPreviewMetrics?.outputWidth} data-quick-height={quickPreviewMetrics?.outputHeight} data-quick-bytes={quickPreviewMetrics?.outputBytes}>
            <div className="editor-column" ref={editorRef} data-view-zoom={view.zoom}
              onKeyDown={event => {
                if (event.key === ' ') event.preventDefault()
                if (['+', '=', '-', '0'].includes(event.key)) {
                  event.preventDefault()
                  setView(current => event.key === '0' ? { zoom: 1, x: 0, y: 0 } : zoomView(current, event.key === '-' ? 100 : -100, { x: 0, y: 0 }))
                }
              }}
              onPointerDownCapture={event => {
                if (!spaceHeld.current && event.button !== 1) return
                event.preventDefault(); event.stopPropagation()
                spacePanned.current = spaceHeld.current
                panStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={event => {
                const start = panStart.current
                if (start?.pointerId === event.pointerId) setView(current => ({ ...current, x: start.viewX + event.clientX - start.x, y: start.viewY + event.clientY - start.y }))
              }}
              onPointerUp={event => { if (panStart.current?.pointerId === event.pointerId) { panStart.current = null; event.currentTarget.releasePointerCapture(event.pointerId) } }}
              onPointerCancel={() => { panStart.current = null }}
            >
                <div className="stage-area" hidden={editorView !== 'edit'} tabIndex={0} aria-label="画像編集ステージ。スクロールで拡大縮小、Spaceとドラッグで表示位置を移動、0で100%表示">
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
                      onKeyDown={(event) => editCropWithKeyboard(event, 'move')}
                      onPointerDown={(event) => beginCropInteraction(event, 'move')}
                    >
                      <span className="crop-guide crop-grid" aria-hidden="true" />
                      {comparisonAvailable && <img className="crop-preview" src={renderedUrl} alt="切り抜き範囲の出力プレビュー" draggable={false} />}

                    </div>
                  </div>
                      {CROP_CORNERS.map(corner => <button
                        key={corner} className="crop-handle" data-corner={corner} type="button"
                        aria-label={`${CORNER_LABELS[corner]}のハンドル。反対の角を固定してリサイズ。矢印キーでサイズ変更、Shiftで大きく変更`}
                        onKeyDown={event => editCropWithKeyboard(event, 'resize', corner)}
                        onPointerDown={event => beginCropInteraction(event, 'resize', corner)}
                      />)}
                </div>

              <section className="comparison-section" aria-label="仕上がりの比較" hidden={editorView !== 'compare'}>
                  <div className="comparison-card">
                    <div className="comparison-stage"><div
                      className="comparison-viewport"
                      style={comparisonFrameStyle}
                      aria-label="元画像と出力結果の比較表示"
                    >
                      <div
                        className="comparison-canvas"
                        onPointerDown={(event) => {
                          if (!comparisonAvailable || !event.isPrimary || event.button !== 0) return
                          event.preventDefault()
                          comparisonInputRef.current?.focus()
                          event.currentTarget.setPointerCapture(event.pointerId)
                          moveComparisonBoundary(event)
                        }}
                        onPointerMove={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId)) moveComparisonBoundary(event)
                        }}
                        onPointerUp={endComparisonDrag}
                        onPointerCancel={endComparisonDrag}
                      >
                        <div
                          className="comparison-layer comparison-original-layer"
                          style={{ clipPath: `inset(0 ${100 - comparisonSplit}% 0 0)` }}
                          aria-hidden={comparisonSplit === 0}
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
                          aria-hidden={comparisonSplit === 100}
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
                            <span className="comparison-layer-label comparison-result-label visually-hidden">
                              {renderedIsPreview ? 'クイック確認' : '保存用画像'}
                            </span>
                          ) : null}
                        </div>

                        {comparisonAvailable ? (
                          <input
                            ref={comparisonInputRef}
                            id="comparison-split"
                            className="comparison-drag-control"
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={comparisonSplit}
                            aria-label="比較の境界。画像上で左右にドラッグ、または矢印キーで調整"
                            aria-valuetext={`元画像 ${comparisonSplit}%、出力結果 ${100 - comparisonSplit}%`}
                            onChange={(event) => setComparisonSplit(Number(event.target.value))}
                          />
                        ) : null}
                        {comparisonAvailable ? (
                          <div className="comparison-divider" style={{ left: `${comparisonSplit}%` }} aria-hidden="true" />
                        ) : null}
                        {!comparisonAvailable ? (
                          <div className="comparison-empty visually-hidden" role="status" aria-live="polite">
                            {previewPending || fullOutputPending
                              ? '出力結果を更新中…'
                              : errorMessage
                                ? '出力結果を表示できません。元画像で編集できます。'
                                : '出力結果を準備しています…'}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    </div>
                  </div>

              </section>
              <div className="crop-stage-meta visually-hidden" role="status" aria-live="polite">
                <span className={`status-chip${busy ? ' is-busy' : ''}`}>
                  {fileError ? 'エラー' : candidatePending ? '画像を読み込み中…' : previewPending ? '圧縮プレビューを更新中…' : fullOutputPending ? '保存用画像を確認中…' : exportPending ? '保存中…' : errorMessage ? 'エラー' : renderedResult ? 'プレビュー準備完了' : '画像を準備中'}
                </span>
                <span className="stage-preview-label">{editorView === 'edit' ? '元画像（切り抜き編集）' : renderedIsPreview ? 'クイック確認' : '保存用画像'}</span>
              </div>
            </div>
          </section>
          <div className="editor-bottom">
            <aside id="output-panel" className="settings-column" aria-label="圧縮" hidden={!outputOpen}>
                <label className="visually-hidden" htmlFor="output-format">形式</label>
                <select id="output-format" value={outputMime} onChange={(event) => updateOutputMime(event.target.value as OutputMime)}>
                  {OUTPUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {outputMime === 'image/png' ? (
                  <p className="comparison-quality-note">PNGでは画質の設定はありません。</p>
                ) : (
                  <div className="range-control">
                    <div className="range-label"><label htmlFor="quality">画質</label><output htmlFor="quality">{Math.round(quality * 100)}%</output></div>
                    <input id="quality" type="range" min="0.01" max="1" step="0.01" value={quality} onChange={(event) => updateQuality(Number(event.target.value))} />
                  </div>
                )}
                <div className="resize-fields">
                  <label htmlFor="resize-width">幅<input id="resize-width" type="number" min="1" step="1" placeholder="自動" value={editState.resize?.width ?? ''} onChange={(event) => updateResize('width', event.target.value)} /></label>
                  <label htmlFor="resize-height">高さ<input id="resize-height" type="number" min="1" step="1" placeholder="自動" value={editState.resize?.height ?? ''} onChange={(event) => updateResize('height', event.target.value)} /></label>
                </div>
                <div className="compression-result">
                <div className="reduction-line" role="status" aria-live="polite"><strong className={!fullOutputMetrics && !processingError ? 'visually-hidden' : undefined}>{fullOutputMetrics ? `${Math.abs(fullOutputMetrics.reductionPercent).toFixed(1)}% ${fullOutputMetrics.reductionPercent >= 0 ? '削減' : '増加'}` : processingError ? '計算できませんでした' : '計算中…'}</strong></div>
                  <button className="download-button" type="button" disabled={busy || !renderedResult} onClick={() => void download()}>保存 <span>.{getOutputExtension(outputMime)}</span></button>
                </div>
                {processingError && !fullOutputResult ? <button className="verify-output-button" type="button" disabled={busy} onClick={() => void confirmFullOutput()}>容量計算を再試行</button> : null}

            </aside>
            <div className="mode-controls crop-controls" hidden={editorMode !== 'crop' || editorView !== 'edit'}>
              <div className="aspect-presets" role="group" aria-label="アスペクト比">
                {ASPECT_OPTIONS.map(option => {
                  const [width = 1, height = 1] = option.value.split(':').map(Number)
                  const ratio = option.value === 'original' ? (geometry.displaySize.imageSize ?? geometry.displaySize).width / (geometry.displaySize.imageSize ?? geometry.displaySize).height : option.value === 'free' ? 4 / 3 : width / height
                  return (
                    <button key={option.value} type="button" className="aspect-preset" data-aspect-ratio={option.value} aria-label={`アスペクト比 ${option.label}`} aria-pressed={editState.aspectRatio === option.value} onClick={() => setAspectRatio(option.value)}>
                      <span className="aspect-icon-box" aria-hidden="true"><span className={`aspect-icon${option.value === 'free' ? ' is-free' : ''}`} style={{ width: `${24 * Math.min(ratio, 1)}px`, height: `${24 / Math.max(ratio, 1)}px` }} /></span>
                      <span>{option.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mode-controls transform-controls" hidden={editorMode !== 'transform' || editorView !== 'edit'}>
              <div className="straighten-control range-control">
                <div className="range-label"><label htmlFor="straighten">傾き</label><output htmlFor="straighten">{(editState.straighten ?? 0).toFixed(1)}°</output></div>
                <input id="straighten" type="range" min="-45" max="45" step="0.1" value={editState.straighten ?? 0} onChange={event => updateEditState(current => straightenEditState(asset.pixels, current, Number(event.target.value)))} />
              </div>
              <div className="transform-buttons">
                <button type="button" className="secondary-button icon-button" aria-label="左へ90°回転" title="左へ90°回転" onClick={() => rotateBy(-90)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9a9 9 0 1 1 0 6M3 3v6h6" /><path d="M9 12h6v6H9z" /></svg></button>
                <button type="button" className="secondary-button icon-button" aria-label="右へ90°回転" title="右へ90°回転" onClick={() => rotateBy(90)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 9a9 9 0 1 0 0 6M21 3v6h-6" /><path d="M9 12h6v6H9z" /></svg></button>
                <button type="button" aria-label="左右反転" title="左右反転" aria-pressed={editState.flipHorizontal} className={`secondary-button icon-button${editState.flipHorizontal ? ' is-selected' : ''}`} onClick={() => updateEditState(current => ({ ...current, flipHorizontal: !current.flipHorizontal }))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20" strokeDasharray="2 2" /><path d="M8 5v14H2zM16 5v14h6z" /></svg></button>
                <button type="button" aria-label="上下反転" title="上下反転" aria-pressed={editState.flipVertical} className={`secondary-button icon-button${editState.flipVertical ? ' is-selected' : ''}`} onClick={() => updateEditState(current => ({ ...current, flipVertical: !current.flipVertical }))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12h20" strokeDasharray="2 2" /><path d="M5 8h14V2zM5 16h14v6z" /></svg></button>
                <button type="button" className="secondary-button icon-button" aria-label="傾きを0°に戻す" title="傾きを0°に戻す" onClick={() => updateEditState(current => straightenEditState(asset.pixels, current, 0))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9a9 9 0 1 1 0 6M3 3v6h6M8 12h8" /></svg></button>

              </div>
            </div>
            <nav className="edit-modes" aria-label="編集モード">
              <button type="button" aria-pressed={editorMode === 'crop'} onClick={() => { setEditorMode('crop'); setView(current => ({ ...current, x: 0, y: 0 })) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2v16h16M2 6h16v16M9 6h9v9" /></svg><span>クロップ</span></button>
              <button type="button" aria-pressed={editorMode === 'transform'} onClick={() => { setEditorMode('transform'); setView(current => ({ ...current, x: 0, y: 0 })) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 4 13 4-4 13L3 17Z M3 3v5h5" /></svg><span>傾き・反転</span></button>
              <button ref={compressionTabRef} type="button" data-mode="compress" aria-controls="output-panel" aria-pressed={outputOpen} onClick={() => { setEditorMode('compress'); setView(current => ({ ...current, x: 0, y: 0 })) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM8 8l4 4 4-4M12 12v5" /></svg><span>圧縮</span></button>
            </nav>
          </div>
        </> : (
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
        {!asset ? <>
        <details className="privacy-details">
          <summary>処理とプライバシーについて</summary>
          <div className="privacy-details-body">
            <p>すべての処理はこのブラウザ内で完結します。ピクセルにデコードしてから再エンコードするため、出力画像のメタデータは削除されます。JPEGの回転もロスレス変換ではなく再エンコードです。</p>
          </div>
        </details>
        </> : null}
      </main>
      {!asset ? <>
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
      </> : null}
    </>
  )
}

export default App
