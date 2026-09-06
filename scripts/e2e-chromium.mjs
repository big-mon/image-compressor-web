import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createMetadataJpegFixture,
  detectMetadataFamilies,
  parseExifOrientation,
  parseJpegDimensions,
} from './e2e-jpeg.mjs'
import {
  assertNetworkIsLocal,
  createStaticSurfaceAllowlist,
  originForRequest,
} from './e2e-network.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIRECTORY = join(REPOSITORY_ROOT, 'dist')
const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEFAULT_BASE_PATH = '/image-compressor-web/'
const DEFAULT_TIMEOUT_MS = 20_000
const EXPECTED_TITLE = '画像圧縮・トリミングをブラウザで | image-compressor-web'
const EXPECTED_DESCRIPTION = 'JPEG・PNG・WebPをブラウザ内でトリミング、回転、反転、リサイズ、圧縮。画像を外部へアップロードせず、メタデータを削除して保存できます。'
const EXPECTED_CANONICAL = 'https://app.damonge.com/image-compressor-web/'
const EXPECTED_H1 = '画像を圧縮・編集'
const EXPECTED_REASSURANCE = '画像は外部に送信されません'
const EXPECTED_PRIVACY_COPY = 'すべての処理はこのブラウザ内で完結します。ピクセルにデコードしてから再エンコードするため、出力画像のメタデータは削除されます。JPEGの回転もロスレス変換ではなく再エンコードです。'
const EXPECTED_FOOTER_COPYRIGHT = '© 2026 image-compressor-web'
const SCREENSHOT_DIRECTORY = process.env.E2E_SCREENSHOT_DIR ? resolve(process.env.E2E_SCREENSHOT_DIR) : undefined
const DESKTOP_VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }
const MOBILE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }
const TABLET_SAVE_LAYOUT_VIEWPORTS = [
  ['tablet-800', { width: 800, height: 1000, deviceScaleFactor: 1, mobile: false }],
  ['tablet-breakpoint-low', { width: 609, height: 1000, deviceScaleFactor: 1, mobile: false }],
  ['tablet-breakpoint-high', { width: 1024, height: 1000, deviceScaleFactor: 1, mobile: false }],
]
const CROP_SURFACE_SIZING_CASES = [
  { key: 'landscape-16-9', filename: 'e2e-landscape-16-9.png', width: 160, height: 90 },
  { key: 'portrait-1-2', filename: 'e2e-portrait-1-2.png', width: 160, height: 320 },
  { key: 'panorama-10-1', filename: 'e2e-panorama-10-1.png', width: 1000, height: 100 },
]

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function normalizeBasePath(value) {
  const basePath = value || DEFAULT_BASE_PATH
  assert(basePath.startsWith('/') && basePath.endsWith('/'), `BASE_PATH must start and end with '/': ${basePath}`)
  assert(!basePath.includes('..'), `BASE_PATH must not contain '..': ${basePath}`)
  return basePath
}

function isRasterWorkerAssetPath(pathname, basePath) {
  const assetPrefix = `${basePath}assets/`
  return pathname.startsWith(assetPrefix) && /^raster\.worker-[^/]+\.js$/i.test(pathname.slice(assetPrefix.length))
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function waitFor(predicate, description, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) {
        return result
      }
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${description}${suffix}`)
}

function spawnExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return
  }
  const exited = spawnExit(child)
  child.kill('SIGTERM')
  await Promise.race([exited, delay(2_000)])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(2_000)])
  }
}

async function assertProductionBuild(basePath) {
  const indexPath = join(DIST_DIRECTORY, 'index.html')
  let indexHtml
  try {
    indexHtml = await readFile(indexPath, 'utf8')
  } catch (error) {
    throw new Error(`dist/index.html is missing. Run BASE_PATH=${basePath} pnpm run build first.`, { cause: error })
  }
  assert(indexHtml.includes(`${basePath}assets/`), `The production build does not use BASE_PATH=${basePath}.`)

  const assetPrefix = `${basePath}assets/`
  const references = [...indexHtml.matchAll(/\b(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], `http://127.0.0.1${basePath}`).pathname)
  const indexScriptPaths = references.filter((pathname) => (
    pathname.startsWith(assetPrefix) && /^index-[^/]+\.js$/i.test(pathname.slice(assetPrefix.length))
  ))
  const indexStylePaths = references.filter((pathname) => (
    pathname.startsWith(assetPrefix) && /^index-[^/]+\.css$/i.test(pathname.slice(assetPrefix.length))
  ))
  assert(indexScriptPaths.length === 1, `Expected one hashed index JS asset in the production build: ${JSON.stringify(indexScriptPaths)}`)
  assert(indexStylePaths.length === 1, `Expected one hashed index CSS asset in the production build: ${JSON.stringify(indexStylePaths)}`)

  const assetDirectory = join(DIST_DIRECTORY, 'assets')
  const workerFiles = (await readdir(assetDirectory)).filter((filename) => /^raster\.worker-[^/]+\.js$/i.test(filename))
  assert(workerFiles.length === 1, `Expected one hashed raster worker asset in the production build: ${JSON.stringify(workerFiles)}`)

  return createStaticSurfaceAllowlist(basePath, [
    indexScriptPaths[0],
    indexStylePaths[0],
    `${assetPrefix}${workerFiles[0]}`,
  ])
}

function contentTypeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

async function serveStaticRequest(request, response, distDirectory, basePath) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }

  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (requestUrl.pathname === basePath.slice(0, -1)) {
    response.writeHead(308, { Location: basePath })
    response.end()
    return
  }
  if (!requestUrl.pathname.startsWith(basePath)) {
    response.writeHead(404)
    response.end()
    return
  }

  let relativePath
  try {
    relativePath = decodeURIComponent(requestUrl.pathname.slice(basePath.length))
  } catch {
    response.writeHead(400)
    response.end()
    return
  }
  const candidatePath = resolve(distDirectory, relativePath)
  const normalizedRoot = resolve(distDirectory)
  const pathIsInsideDist = candidatePath === normalizedRoot || candidatePath.startsWith(`${normalizedRoot}/`)
  if (!pathIsInsideDist || relativePath.includes('\0')) {
    response.writeHead(400)
    response.end()
    return
  }

  let filePath = candidatePath
  let fileInfo
  try {
    fileInfo = await stat(filePath)
    if (fileInfo.isDirectory()) {
      filePath = join(filePath, 'index.html')
      fileInfo = await stat(filePath)
    }
  } catch {
    const acceptsHtml = request.headers.accept?.includes('text/html')
    if (!acceptsHtml) {
      response.writeHead(404)
      response.end()
      return
    }
    filePath = join(distDirectory, 'index.html')
    fileInfo = await stat(filePath)
  }

  assert(fileInfo.isFile(), `Static path is not a file: ${relative(filePath, distDirectory)}`)
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': fileInfo.size,
    'Content-Type': contentTypeFor(filePath),
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  response.end(await readFile(filePath))
}

async function startStaticServer(basePath) {
  const requestLog = []
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.once('finish', () => {
      requestLog.push({
        method: request.method ?? '',
        pathname: requestUrl.pathname,
        statusCode: response.statusCode,
      })
    })
    void serveStaticRequest(request, response, DIST_DIRECTORY, basePath).catch((error) => {
      response.destroy(error instanceof Error ? error : undefined)
    })
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert(address && typeof address === 'object', 'The static server did not expose an address.')
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    pageUrl: `${origin}${basePath}`,
    requestLog,
    server,
  }
}

async function closeServer(server) {
  if (!server) {
    return
  }
  await new Promise((resolvePromise) => server.close(() => resolvePromise()))
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl)
    this.nextId = 0
    this.pending = new Map()
    this.listeners = []
    this.openPromise = new Promise((resolvePromise, reject) => {
      this.resolveOpen = resolvePromise
      this.rejectOpen = reject
    })
    this.socket.addEventListener('open', () => this.resolveOpen())
    this.socket.addEventListener('error', (event) => {
      const error = new Error(`CDP WebSocket error: ${event.message ?? 'unknown error'}`)
      this.rejectOpen(error)
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
    })
    this.socket.addEventListener('close', () => {
      const error = new Error('CDP WebSocket closed.')
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
    })
    this.socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data)
    })
  }

  async handleMessage(data) {
    let text
    if (typeof data === 'string') {
      text = data
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data)
    } else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(data)
    } else {
      text = String(data)
    }
    const message = JSON.parse(text)
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      this.pending.delete(message.id)
      clearTimeout(pending.timeoutId)
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    for (const listener of this.listeners) {
      if (listener.method === message.method && listener.sessionId === message.sessionId) {
        listener.handler(message.params)
      }
    }
  }

  async open() {
    await this.openPromise
    return this
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId
    return new Promise((resolvePromise, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for CDP ${method}.`))
      }, DEFAULT_TIMEOUT_MS)
      this.pending.set(id, { method, reject, resolve: resolvePromise, timeoutId })
      const message = { id, method, params }
      if (sessionId) {
        message.sessionId = sessionId
      }
      this.socket.send(JSON.stringify(message))
    })
  }

  on(method, handler, sessionId) {
    const listener = { handler, method, sessionId }
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) {
        this.listeners.splice(index, 1)
      }
    }
  }

  async close() {
    this.listeners = []
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close()
    }
  }
}

async function launchChrome(profileDirectory) {
  await access(CHROME_PATH)
  const args = [
    '--headless=new',
    `--user-data-dir=${profileDirectory}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-extensions',
    '--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,Translate',
    '--disable-popup-blocking',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-service-autorun',
  ]
  const chrome = spawn(CHROME_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let resolveWebSocket
  let rejectWebSocket
  const webSocketPromise = new Promise((resolvePromise, reject) => {
    resolveWebSocket = resolvePromise
    rejectWebSocket = reject
  })
  const inspectOutput = (chunk) => {
    output += chunk.toString()
    const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (match) {
      resolveWebSocket(match[1])
    }
  }
  chrome.stdout.on('data', inspectOutput)
  chrome.stderr.on('data', inspectOutput)
  chrome.once('error', rejectWebSocket)
  chrome.once('exit', (code, signal) => {
    if (code !== null || signal !== null) {
      rejectWebSocket(new Error(`Chrome exited before CDP startup (code=${code}, signal=${signal}).\n${output}`))
    }
  })

  let webSocketUrl
  try {
    webSocketUrl = await Promise.race([
      webSocketPromise,
      delay(15_000).then(() => { throw new Error(`Timed out waiting for Chrome CDP startup.\n${output}`) }),
    ])
  } catch (error) {
    await stopChild(chrome)
    throw error
  }
  return { chrome, webSocketUrl }
}

function getRemoteObjectText(remoteObject) {
  if (remoteObject?.value !== undefined) {
    return typeof remoteObject.value === 'string' ? remoteObject.value : JSON.stringify(remoteObject.value)
  }
  return remoteObject?.description ?? remoteObject?.unserializableValue ?? remoteObject?.type ?? ''
}

class BrowserDiagnostics {
  constructor(cdp, sessionId) {
    this.consoleErrors = []
    this.exceptions = []
    this.logErrors = []
    cdp.on('Runtime.consoleAPICalled', (event) => {
      if (event.type !== 'error') {
        return
      }
      this.consoleErrors.push({
        arguments: (event.args ?? []).map(getRemoteObjectText),
        stack: event.stackTrace?.description ?? '',
      })
    }, sessionId)
    cdp.on('Runtime.exceptionThrown', (event) => {
      this.exceptions.push({
        description: event.exceptionDetails?.exception?.description ?? '',
        text: event.exceptionDetails?.text ?? '',
      })
    }, sessionId)
    cdp.on('Log.entryAdded', (event) => {
      if (event.entry?.level === 'error') {
        this.logErrors.push({
          lineNumber: event.entry.lineNumber ?? null,
          message: event.entry.text ?? '',
          source: event.entry.source ?? '',
          url: event.entry.url ?? '',
        })
      }
    }, sessionId)
  }

  assertClean() {
    assert(this.consoleErrors.length === 0, `Browser console.error occurred: ${JSON.stringify(this.consoleErrors)}`)
    assert(this.exceptions.length === 0, `Unhandled page exception occurred: ${JSON.stringify(this.exceptions)}`)
    assert(this.logErrors.length === 0, `Browser log error occurred: ${JSON.stringify(this.logErrors)}`)
  }
}

class NetworkRecorder {
  constructor(cdp, sessionId) {
    this.entries = new Map()
    this.webSockets = new Map()
    cdp.on('Network.requestWillBeSent', (event) => {
      const url = event.request?.url ?? ''
      if (!/^https?:/i.test(url)) {
        return
      }
      this.entries.set(event.requestId, {
        hasPostData: event.request?.hasPostData === true,
        kind: 'http',
        method: event.request?.method ?? 'GET',
        resourceType: event.type ?? '',
        url,
      })
    }, sessionId)
    cdp.on('Network.responseReceived', (event) => {
      const entry = this.entries.get(event.requestId)
      if (entry) {
        entry.status = event.response?.status
      }
    }, sessionId)
    cdp.on('Network.loadingFailed', (event) => {
      const entry = this.entries.get(event.requestId)
      if (entry) {
        entry.failed = true
        entry.errorText = event.errorText ?? ''
      }
    }, sessionId)
    cdp.on('Network.webSocketCreated', (event) => {
      const url = event.url ?? ''
      if (/^wss?:/i.test(url)) {
        this.webSockets.set(event.requestId, { kind: 'websocket', url })
      }
    }, sessionId)
    cdp.on('Network.webSocketWillSendHandshakeRequest', (event) => {
      const entry = this.webSockets.get(event.requestId)
      if (entry) {
        entry.method = event.request?.headers?.[':method'] ?? 'GET'
      }
    }, sessionId)
  }

  getObservedRequests() {
    return [...this.getObservedHttpRequests(), ...this.webSockets.values()]
  }

  getObservedHttpRequests() {
    return [...this.entries.values()]
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true,
  }, sessionId)
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown exception'
    throw new Error(`Page evaluation failed: ${description}`)
  }
  return result.result?.value
}

async function waitForDom(cdp, sessionId, expression, description, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return waitFor(() => evaluate(cdp, sessionId, expression), description, timeoutMs)
}

async function waitForFileLoad(cdp, sessionId) {
  try {
    await waitForDom(cdp, sessionId, `document.querySelector('section[aria-label="画像エディター"]') !== null`, 'the real file input change to open the editor')
  } catch (error) {
    const errorMessage = await evaluate(cdp, sessionId, `document.querySelector('.error-message')?.textContent?.trim() ?? ''`).catch(() => '')
    throw new Error(`${error instanceof Error ? error.message : String(error)} (error-message: ${JSON.stringify(errorMessage)})`, { cause: error })
  }
}

async function setViewport(cdp, sessionId, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  }, sessionId)
}

async function captureScreenshot(cdp, sessionId, filename) {
  if (!SCREENSHOT_DIRECTORY) {
    return undefined
  }
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true })
  const result = await cdp.send('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true,
  }, sessionId)
  const screenshotPath = join(SCREENSHOT_DIRECTORY, filename)
  await writeFile(screenshotPath, Buffer.from(result.data, 'base64'))
  return screenshotPath
}

async function captureToolLayout(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const describe = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        bottom: rect.bottom,
        fontSize: Number.parseFloat(style.fontSize),
        height: rect.height,
        left: rect.left,
        right: rect.right,
        text: element.textContent?.trim() ?? '',
        top: rect.top,
        cursor: style.cursor,
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        width: rect.width,
      }
    }
    const describeBox = (rect) => ({
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
    })
    const describeProcessedPreview = (image) => {
      if (!(image instanceof HTMLImageElement)) return null
      const imageRect = image.getBoundingClientRect()
      const style = getComputedStyle(image)
      return {
        image: {
          ...describeBox(imageRect),
          visible: imageRect.width > 0 && imageRect.height > 0 && style.visibility !== 'hidden',
        },
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        minHeight: style.minHeight,
        minWidth: style.minWidth,
        naturalHeight: image.naturalHeight,
        naturalWidth: image.naturalWidth,
        objectFit: style.objectFit,
        visibility: style.visibility,
      }
    }
    const readDimensions = (selector) => {
      const text = document.querySelector(selector)?.textContent?.trim() ?? ''
      const values = text.replace(' px', '').split(' × ').map(Number)
      return values.length === 2 && values.every((value) => Number.isFinite(value))
        ? { width: values[0], height: values[1] }
        : null
    }
    const dropZone = document.querySelector('.drop-zone')
    const advancedControls = document.querySelector('.advanced-controls')
    const privacyDetails = document.querySelector('.privacy-details')
    return {
      advancedControls: advancedControls ? {
        ...describe('.advanced-controls'),
        open: advancedControls.open,
      } : null,
      changeImage: describe('.change-image-button'),
      aspectRatio: describe('#aspect-ratio'),
      compositionGuide: describe('#composition-guide'),
      cropSurface: describe('.crop-surface'),
      dropZone: dropZone ? {
        ...describe('.drop-zone'),
        htmlFor: dropZone.htmlFor,
        role: dropZone.getAttribute('role'),
        tabIndex: dropZone.tabIndex,
      } : null,
      emptyStatePresent: document.querySelector('.empty-state') !== null,
      editor: describe('.editor-column'),
      editorActions: describe('.editor-actions'),
      editorHeaderPresent: [...document.querySelectorAll('.editor-column .section-kicker, .editor-column h2')].some((element) => (
        element.textContent?.trim() === 'EDITOR' || element.textContent?.trim() === '切り抜きと見え方'
      )),
      h1: describe('h1'),
      h1Count: document.querySelectorAll('h1').length,
      mobileWidth: window.innerWidth,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1,
      cropRectangle: describe('.crop-rectangle'),
      legacyPreviewPanelCount: document.querySelectorAll('.comparison-section, .comparison-card, .comparison-media, .after-card').length,
      outputFormat: describe('#output-format'),
      privacyCardPresent: document.querySelector('.privacy-card') !== null,
      privacyCopy: document.querySelector('.privacy-details-body')?.textContent?.trim() ?? '',
      quality: describe('#quality'),
      reassurance: describe('.tool-reassurance'),
      comparisonHold: {
        ...describe('.comparison-hold-button'),
        disabled: document.querySelector('.comparison-hold-button')?.hasAttribute('disabled') ?? false,
        text: document.querySelector('.comparison-hold-button')?.textContent?.trim() ?? '',
      },
      previewLabel: describe('.stage-preview-label'),
      previewLabelText: document.querySelector('.stage-preview-label')?.textContent?.trim() ?? '',
      processedPreview: describeProcessedPreview(document.querySelector('.processed-preview')),
      processedPreviewCount: document.querySelectorAll('.processed-preview').length,
      renderedSize: readDimensions('.metrics-card .metric-line:nth-child(3) strong'),
      settings: describe('.settings-column'),
      sourceImageCount: document.querySelectorAll('.stage-image').length,
      sourceMetrics: describe('.metrics-card .metric-line:first-child strong'),
      stageArea: describe('.stage-area'),
      workspace: describe('.workspace'),
      download: describe('.download-button'),
      privacyDetails: privacyDetails ? {
        ...describe('.privacy-details'),
        open: privacyDetails.open,
      } : null,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    }
  })()`)
}

async function captureSaveLayout(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const describe = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      }
    }
    const settings = document.querySelector('.settings-column')
    const settingsStyle = settings ? getComputedStyle(settings) : null
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      download: describe('.download-button'),
      hint: describe('.download-hint'),
      metrics: describe('.metrics-card'),
      outputCard: describe('.output-card'),
      settings: describe('.settings-column'),
      settingsDisplay: settingsStyle?.display,
      settingsGridTemplateColumns: settingsStyle?.gridTemplateColumns,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }
  })()`)
}

function assertVisibleRect(rect, description) {
  assert(rect?.visible && rect.width > 0 && rect.height > 0, `${description} is not visible: ${JSON.stringify(rect)}`)
}

function assertInsideViewport(rect, viewport, description) {
  assertVisibleRect(rect, description)
  assert(rect.top >= -1 && rect.bottom <= viewport.height + 1, `${description} is outside the initial viewport: ${JSON.stringify({ rect, viewport })}`)
}

function assertRectsDoNotOverlap(first, second, description) {
  const overlaps = first.left < second.right - 1 &&
    first.right > second.left + 1 &&
    first.top < second.bottom - 1 &&
    first.bottom > second.top + 1
  assert(!overlaps, `${description} overlap: ${JSON.stringify({ first, second })}`)
}

async function runTabletSaveLayoutRegression({ cdp, sessionId }) {
  const results = {}
  for (const [key, viewport] of TABLET_SAVE_LAYOUT_VIEWPORTS) {
    await setViewport(cdp, sessionId, viewport)
    await waitForDom(cdp, sessionId, `window.innerWidth === ${viewport.width} && window.innerHeight === ${viewport.height}`, `the ${key} save layout viewport`)
    await evaluate(cdp, sessionId, 'window.scrollTo(0, 0)')
    const layout = await captureSaveLayout(cdp, sessionId)
    assert(layout.settingsDisplay === 'grid', `${key} settings did not use the tablet grid: ${JSON.stringify(layout)}`)
    assert(layout.viewportWidth === viewport.width && layout.viewportHeight === viewport.height, `Unexpected ${key} viewport: ${JSON.stringify(layout)}`)
    assert(layout.documentScrollWidth <= layout.documentClientWidth + 1 && layout.bodyScrollWidth <= layout.documentClientWidth + 1, `${key} layout overflows horizontally: ${JSON.stringify(layout)}`)
    assert(layout.download.height >= 40 && layout.download.height <= 56, `${key} download button is not a normal-height control: ${JSON.stringify(layout)}`)
    assert(layout.download.top >= layout.outputCard.bottom - 1, `${key} download button overlaps the output card: ${JSON.stringify(layout)}`)
    assert(layout.hint.top >= layout.outputCard.bottom - 1, `${key} save hint overlaps the output card: ${JSON.stringify(layout)}`)
    assert(layout.metrics.top >= layout.settings.top - 1, `${key} metrics card escaped the settings flow: ${JSON.stringify(layout)}`)
    assertRectsDoNotOverlap(layout.outputCard, layout.metrics, `${key} output card and metrics card`)
    assertRectsDoNotOverlap(layout.outputCard, layout.download, `${key} output card and download button`)
    assertRectsDoNotOverlap(layout.metrics, layout.hint, `${key} metrics card and save hint`)
    const downloadCenter = (layout.download.top + layout.download.bottom) / 2
    const hintCenter = (layout.hint.top + layout.hint.bottom) / 2
    assert(Math.abs(downloadCenter - hintCenter) <= 2, `${key} download button and hint are not a coherent save row: ${JSON.stringify({ download: layout.download, hint: layout.hint })}`)

    const scrolledButton = await evaluate(cdp, sessionId, `(() => {
      const button = document.querySelector('.download-button')
      if (!(button instanceof HTMLElement)) return null
      button.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = button.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      }
    })()`)
    assert(scrolledButton && scrolledButton.top >= 0 && scrolledButton.bottom <= scrolledButton.viewportHeight && scrolledButton.left >= 0 && scrolledButton.right <= scrolledButton.viewportWidth, `${key} download button was not usable after scrolling it into view: ${JSON.stringify(scrolledButton)}`)
    results[key] = { layout, scrolledButton }
  }
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport after tablet save layout checks')
  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0)')
  return results
}

function assertProcessedPreviewAligned(layout, mode) {
  const preview = layout.processedPreview
  const description = `${mode} processed preview image`
  assert(layout.processedPreviewCount === 1 && preview, `Expected one in-stage processed preview on ${mode}: ${JSON.stringify(layout)}`)
  assertVisibleRect(preview.image, description)
  assert(preview.objectFit === 'fill', `${description} does not fill its crop bounds: ${JSON.stringify(preview)}`)
  assert(preview.minWidth === '0px' && preview.minHeight === '0px', `${description} uses crop-rectangle minimum bounds: ${JSON.stringify(preview)}`)
  assert(preview.naturalWidth === layout.renderedSize?.width && preview.naturalHeight === layout.renderedSize?.height, `${description} natural dimensions do not match the rendered metrics: ${JSON.stringify({ preview, renderedSize: layout.renderedSize })}`)
  assert(layout.cropRectangle && Math.abs(preview.image.left - layout.cropRectangle.left) <= 1 && Math.abs(preview.image.right - layout.cropRectangle.right) <= 1 && Math.abs(preview.image.top - layout.cropRectangle.top) <= 1 && Math.abs(preview.image.bottom - layout.cropRectangle.bottom) <= 1, `${description} is not mapped to the crop rectangle: ${JSON.stringify({ crop: layout.cropRectangle, preview: preview.image })}`)
  assert(preview.backgroundColor !== 'rgba(0, 0, 0, 0)' && preview.backgroundImage !== 'none', `${description} has no opaque checker/base behind transparent pixels: ${JSON.stringify(preview)}`)
}

async function assertEmptyFirstView(cdp, sessionId, viewport, mode) {
  const layout = await captureToolLayout(cdp, sessionId)
  assert(layout.viewportWidth === viewport.width && layout.viewportHeight === viewport.height, `Unexpected empty ${mode} viewport: ${JSON.stringify(layout)}`)
  assert(layout.h1Count === 1 && layout.h1?.text === EXPECTED_H1, `Expected one compact tool H1 in the empty state: ${JSON.stringify(layout)}`)
  assert(layout.h1.fontSize <= 32, `The tool H1 is too large for a compact toolbar: ${JSON.stringify(layout.h1)}`)
  assertInsideViewport(layout.h1, viewport, `empty ${mode} H1`)
  assertVisibleRect(layout.dropZone, `empty ${mode} drop zone`)
  assert(layout.dropZone.top <= viewport.height * 0.2 && layout.dropZone.height >= viewport.height * 0.45, `The empty drop zone does not occupy useful first-view space: ${JSON.stringify({ dropZone: layout.dropZone, viewport })}`)
  assert(layout.dropZone.bottom <= viewport.height + 1, `The empty drop zone is not available in the first viewport: ${JSON.stringify(layout.dropZone)}`)
  assert(layout.dropZone.role === 'button' && layout.dropZone.tabIndex === 0 && layout.dropZone.htmlFor === 'image-input', `The empty drop zone is not keyboard/file-input reachable: ${JSON.stringify(layout.dropZone)}`)
  assert(layout.emptyStatePresent === false && layout.privacyCardPresent === false, `Legacy empty/hero content remains in the empty state: ${JSON.stringify(layout)}`)
  assert(layout.changeImage === null, `The loaded-only change-image affordance is visible before selection: ${JSON.stringify(layout.changeImage)}`)
  assert(layout.dropZone.cursor === 'pointer', `The empty ${mode} drop zone is not pointer-activated: ${JSON.stringify(layout.dropZone)}`)
  assert(layout.reassurance?.text === EXPECTED_REASSURANCE, `The no-upload reassurance changed unexpectedly: ${JSON.stringify(layout.reassurance)}`)
  assert(layout.privacyCopy === EXPECTED_PRIVACY_COPY, `The privacy disclosure changed unexpectedly: ${JSON.stringify(layout.privacyCopy)}`)
  assert(layout.privacyDetails?.open === false, `Technical privacy details must remain collapsed on empty ${mode}: ${JSON.stringify(layout.privacyDetails)}`)
  assertInsideViewport(layout.reassurance, viewport, `no-upload reassurance on empty ${mode}`)
  assert(layout.noHorizontalOverflow, `Empty ${mode} layout overflows horizontally: ${JSON.stringify(layout)}`)
  const focusReachedDropZone = await evaluate(cdp, sessionId, `(() => {
    const dropZone = document.querySelector('.drop-zone')
    dropZone?.focus()
    return document.activeElement === dropZone
  })()`)
  assert(focusReachedDropZone === true, `The empty ${mode} drop zone could not receive keyboard focus.`)
  return layout
}

async function assertLoadedFirstView(cdp, sessionId, viewport, mode) {
  const layout = await captureToolLayout(cdp, sessionId)
  assert(layout.viewportWidth === viewport.width && layout.viewportHeight === viewport.height, `Unexpected ${mode} viewport: ${JSON.stringify(layout)}`)
  assert(layout.dropZone === null, `The full upload area remains after loading on ${mode}: ${JSON.stringify(layout.dropZone)}`)
  assertVisibleRect(layout.changeImage, `${mode} change-image affordance`)
  assert(layout.editorHeaderPresent === false, `The legacy editor heading remains on ${mode}: ${JSON.stringify(layout)}`)
  assert(layout.sourceImageCount === 1, `The original image is not represented by exactly one stage image on ${mode}: ${JSON.stringify(layout)}`)
  assert(layout.legacyPreviewPanelCount === 0, `The retired duplicate preview panel remains on ${mode}: ${JSON.stringify(layout)}`)
  assertVisibleRect(layout.cropSurface, `${mode} crop surface`)
  assertVisibleRect(layout.stageArea, `${mode} stage area`)
  assert(layout.reassurance?.text === EXPECTED_REASSURANCE, `The loaded ${mode} privacy reassurance changed unexpectedly: ${JSON.stringify(layout.reassurance)}`)
  assertInsideViewport(layout.reassurance, viewport, `no-upload reassurance on loaded ${mode}`)
  assert(layout.privacyDetails?.open === false, `Technical privacy details must remain collapsed on loaded ${mode}: ${JSON.stringify(layout.privacyDetails)}`)
  assert(Math.abs(layout.stageArea.width - layout.editor.width) <= 2, `${mode} stage area does not fill the editor column: ${JSON.stringify({ editor: layout.editor, stageArea: layout.stageArea })}`)
  assert(layout.stageArea.height >= (mode === 'mobile' ? 400 : 500), `${mode} stage area was not enlarged for the full-window editor: ${JSON.stringify({ stageArea: layout.stageArea, viewport })}`)
  assert(layout.cropSurface.height > (mode === 'mobile' ? 204 : 324), `${mode} portrait crop surface did not grow beyond the retired height cap: ${JSON.stringify(layout.cropSurface)}`)
  assertVisibleRect(layout.editorActions, `${mode} crop action row`)
  assertVisibleRect(layout.compositionGuide, `${mode} composition guide control`)
  assert(layout.editorActions.top >= layout.stageArea.bottom - 1 && layout.editorActions.top - layout.stageArea.bottom < 24, `${mode} crop action row is not immediately after the stage area: ${JSON.stringify({ stageArea: layout.stageArea, cropSurface: layout.cropSurface, editorActions: layout.editorActions })}`)
  assertVisibleRect(layout.aspectRatio, `${mode} aspect ratio control`)
  assertVisibleRect(layout.comparisonHold, `${mode} original comparison hold control`)
  assert(layout.comparisonHold.text === '押して元画像を表示' && layout.comparisonHold.disabled === false, `${mode} original comparison hold control is not available: ${JSON.stringify(layout.comparisonHold)}`)
  assert(layout.previewLabelText === '圧縮後', `${mode} processed preview label is not visible: ${JSON.stringify(layout.previewLabel)}`)
  assertProcessedPreviewAligned(layout, mode)
  assert(layout.advancedControls && layout.advancedControls.open === false && layout.advancedControls.top > layout.editorActions.bottom, `Advanced controls are not deferred below the image editor on ${mode}: ${JSON.stringify(layout.advancedControls)}`)
  assert(layout.noHorizontalOverflow, `Loaded ${mode} layout overflows horizontally: ${JSON.stringify(layout)}`)

  if (mode === 'desktop') {
    assertInsideViewport(layout.stageArea, viewport, 'desktop stage area')
    assertInsideViewport(layout.editorActions, viewport, 'desktop crop action row')
    assert(layout.settings.left >= layout.editor.right - 1, `Desktop output settings are not in a right sidebar: ${JSON.stringify({ editor: layout.editor, settings: layout.settings })}`)
    assertInsideViewport(layout.outputFormat, viewport, 'desktop output format')
    assertInsideViewport(layout.quality, viewport, 'desktop quality')
    assertInsideViewport(layout.download, viewport, 'desktop download')
    assert(layout.outputFormat.fontSize >= 16 && layout.download.fontSize >= 16, `Desktop key output controls are too small: ${JSON.stringify({ outputFormat: layout.outputFormat, download: layout.download })}`)
  } else {
    assert(layout.settings.left <= layout.workspace.left + 1, `Mobile output settings did not align with the image workspace: ${JSON.stringify({ workspace: layout.workspace, settings: layout.settings })}`)
    assert(layout.settings.top >= layout.editorActions.bottom - 1, `Mobile output settings overlap the crop action row: ${JSON.stringify({ editorActions: layout.editorActions, settings: layout.settings })}`)
    assert(layout.outputFormat.top > layout.editorActions.bottom, `Mobile output controls do not follow the image workspace: ${JSON.stringify({ editorActions: layout.editorActions, outputFormat: layout.outputFormat })}`)
    assertVisibleRect(layout.outputFormat, 'mobile output format')
    assertVisibleRect(layout.quality, 'mobile quality')
    assertVisibleRect(layout.download, 'mobile download')
    assert(layout.outputFormat.top < layout.advancedControls.top && layout.download.bottom < layout.advancedControls.top, `Mobile essential output/save controls do not precede advanced controls: ${JSON.stringify(layout)}`)
  }
  return layout
}

async function captureCropSurfaceSizing(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const surface = document.querySelector('.crop-surface')
    const sourceImage = document.querySelector('.stage-image')
    const stageArea = document.querySelector('.stage-area')
    const stageAreaRect = stageArea?.getBoundingClientRect()
    const stageAreaStyle = stageArea ? getComputedStyle(stageArea) : undefined
    const surfaceRect = surface?.getBoundingClientRect()
    const sourceRect = sourceImage?.getBoundingClientRect()
    const toPixels = (value) => Number.parseFloat(value) || 0
    const contentBox = stageAreaRect && stageAreaStyle ? {
      height: stageAreaRect.height -
        toPixels(stageAreaStyle.paddingTop) -
        toPixels(stageAreaStyle.paddingBottom) -
        toPixels(stageAreaStyle.borderTopWidth) -
        toPixels(stageAreaStyle.borderBottomWidth),
      width: stageAreaRect.width -
        toPixels(stageAreaStyle.paddingLeft) -
        toPixels(stageAreaStyle.paddingRight) -
        toPixels(stageAreaStyle.borderLeftWidth) -
        toPixels(stageAreaStyle.borderRightWidth),
    } : undefined
    const describeBox = (rect) => rect ? {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
    } : undefined
    return {
      availableHeight: contentBox?.height,
      availableWidth: contentBox?.width,
      sourceNaturalHeight: sourceImage?.naturalHeight,
      sourceNaturalWidth: sourceImage?.naturalWidth,
      sourceRect: describeBox(sourceRect),
      sourceFitsSurface: Boolean(sourceRect && surfaceRect &&
        sourceRect.left >= surfaceRect.left - 2 &&
        sourceRect.right <= surfaceRect.right + 2 &&
        sourceRect.top >= surfaceRect.top - 2 &&
        sourceRect.bottom <= surfaceRect.bottom + 2),
      stageArea: describeBox(stageAreaRect),
      surfaceFitsStageArea: Boolean(surfaceRect && stageAreaRect &&
        surfaceRect.left >= stageAreaRect.left - 2 &&
        surfaceRect.right <= stageAreaRect.right + 2 &&
        surfaceRect.top >= stageAreaRect.top - 2 &&
        surfaceRect.bottom <= stageAreaRect.bottom + 2),
      surfaceHeight: surfaceRect?.height,
      surfaceRatio: surfaceRect ? surfaceRect.width / surfaceRect.height : undefined,
      surfaceWidth: surfaceRect?.width,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    }
  })()`)
}

async function runCropSurfaceSizingRegression({ cdp, sessionId, layoutFixtures }) {
  const results = {}
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport for crop surface sizing')

  for (const fixture of layoutFixtures) {
    const fixtureDataUrl = await evaluate(cdp, sessionId, `(() => {
      const canvas = document.createElement('canvas')
      canvas.width = ${fixture.width}
      canvas.height = ${fixture.height}
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not create a 2D canvas context for the layout fixture.')
      const halfWidth = canvas.width / 2
      const halfHeight = canvas.height / 2
      const quadrants = [
        ['#e63946', 0, 0, halfWidth, halfHeight],
        ['#457b9d', halfWidth, 0, halfWidth, halfHeight],
        ['#f4a261', 0, halfHeight, halfWidth, halfHeight],
        ['#2a9d8f', halfWidth, halfHeight, halfWidth, halfHeight],
      ]
      for (const [color, x, y, width, height] of quadrants) {
        context.fillStyle = color
        context.fillRect(x, y, width, height)
      }
      return canvas.toDataURL('image/png')
    })()`)
    const encodedFixture = fixtureDataUrl?.match(/^data:image\/png;base64,(.+)$/)?.[1]
    assert(encodedFixture, `${fixture.key} browser canvas did not return a PNG data URL.`)
    await writeFile(fixture.path, Buffer.from(encodedFixture, 'base64'))
    await setFileInput(cdp, sessionId, fixture.path)
    const expectedDimensions = `${fixture.width} × ${fixture.height} px`
    await waitForDom(cdp, sessionId, `document.querySelector('.metrics-card .metric-line:first-child strong')?.textContent?.trim() === ${JSON.stringify(expectedDimensions)}`, `${fixture.key} source dimensions`)
    await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, `${fixture.key} Worker preview`)

    const caseResults = {}
    for (const [mode, viewport] of [
      ['desktop', DESKTOP_VIEWPORT],
      ['mobile', MOBILE_VIEWPORT],
    ]) {
      await setViewport(cdp, sessionId, viewport)
      await waitForDom(cdp, sessionId, `window.innerWidth === ${viewport.width} && window.innerHeight === ${viewport.height}`, `the ${mode} viewport for ${fixture.key}`)
      const layout = await captureCropSurfaceSizing(cdp, sessionId)
      const aspectRatio = fixture.width / fixture.height
      assert(layout.sourceNaturalWidth === fixture.width && layout.sourceNaturalHeight === fixture.height, `${fixture.key} source dimensions were not decoded as expected: ${JSON.stringify(layout)}`)
      assert(layout.availableWidth > 0 && layout.availableHeight > 0, `${fixture.key} has no measurable ${mode} stage area: ${JSON.stringify(layout)}`)
      assert(layout.surfaceWidth <= layout.availableWidth + 2 && layout.surfaceHeight <= layout.availableHeight + 2, `${fixture.key} escaped the ${mode} stage area bounds: ${JSON.stringify(layout)}`)
      assert(layout.surfaceFitsStageArea, `${fixture.key} was not letterboxed within the ${mode} stage area: ${JSON.stringify(layout)}`)
      assert(layout.sourceFitsSurface, `${fixture.key} whole source image was not contained by the ${mode} crop surface: ${JSON.stringify(layout)}`)
      assert(Math.abs(layout.surfaceRatio - aspectRatio) <= Math.max(0.05, aspectRatio * 0.01), `${fixture.key} changed its ${mode} aspect ratio: ${JSON.stringify({ layout, aspectRatio })}`)
      assert(layout.stageArea.height >= (mode === 'desktop' ? 500 : 400), `${fixture.key} did not receive an enlarged ${mode} working area: ${JSON.stringify(layout)}`)
      if (fixture.key === 'landscape-16-9') {
        assert(Math.abs(layout.surfaceWidth - layout.availableWidth) <= 4, `${fixture.key} did not use the available ${mode} width: ${JSON.stringify(layout)}`)
      }
      if (fixture.key === 'panorama-10-1') {
        assert(Math.abs(layout.surfaceWidth - layout.availableWidth) <= 4, `${fixture.key} did not use the available ${mode} width: ${JSON.stringify(layout)}`)
      }
      await captureScreenshot(cdp, sessionId, `${fixture.key}-${mode}.png`)
      caseResults[mode] = layout
    }
    results[fixture.key] = caseResults
  }
  return results
}

async function openDetails(cdp, sessionId, selector) {
  const quotedSelector = JSON.stringify(selector)
  const opened = await evaluate(cdp, sessionId, `(() => {
    const details = document.querySelector(${quotedSelector})
    if (!(details instanceof HTMLDetailsElement)) throw new Error('Details element not found: ' + ${quotedSelector})
    const summary = details.querySelector(':scope > summary')
    if (!(summary instanceof HTMLElement)) throw new Error('Details summary not found: ' + ${quotedSelector})
    summary.click()
    return details.open
  })()`)
  assert(opened === true, `Could not open details disclosure: ${selector}`)
}

async function assertPublicMetadataAndFooter(cdp, sessionId, basePath) {
  const expectedFooterLinks = [
    { rawHref: '/', text: 'App Hubへ戻る', external: false },
    { rawHref: 'https://x.com/big_mon', text: 'X @big_mon', external: true },
    { rawHref: 'https://github.com/big-mon/image-compressor-web', text: 'GitHub', external: true },
    { rawHref: `${basePath}guide.html`, text: '使い方ガイド', external: false },
  ]
  const pageContract = await evaluate(cdp, sessionId, `(() => {
    const serializeAnchor = (anchor) => ({
      rawHref: anchor.getAttribute('href') ?? '',
      resolvedHref: anchor.href,
      rel: anchor.getAttribute('rel') ?? '',
      target: anchor.getAttribute('target') ?? '',
      text: anchor.textContent?.trim() ?? '',
    })
    const canonicalLinks = document.querySelectorAll('link[rel="canonical"]')
    const descriptionMetas = document.querySelectorAll('meta[name="description"]')
    const footerNodes = document.querySelectorAll('footer.site-footer')
    const footer = footerNodes[0]
    const footerNavigation = document.querySelectorAll('footer.site-footer nav.footer-links[aria-label="フッターナビゲーション"]')
    const footerInner = footer?.querySelector(':scope > .footer-inner')
    const footerAnchors = [...footerNavigation].flatMap((navigation) => [...navigation.querySelectorAll('a[href]')])
    const externalAnchors = [...document.querySelectorAll('a[href]')]
      .filter((anchor) => /^https?:/i.test(anchor.getAttribute('href') ?? ''))
    return {
      canonical: canonicalLinks[0]?.getAttribute('href') ?? '',
      canonicalCount: canonicalLinks.length,
      description: descriptionMetas[0]?.getAttribute('content') ?? '',
      descriptionCount: descriptionMetas.length,
      externalAnchorCount: externalAnchors.length,
      externalAnchorOutsideFooterCount: externalAnchors.filter((anchor) => !footer?.contains(anchor)).length,
      footerCopyright: footerInner?.querySelector(':scope > span')?.textContent?.trim() ?? '',
      footerCopyrightCount: footerInner?.querySelectorAll(':scope > span').length ?? 0,
      footerInnerCount: footer?.querySelectorAll(':scope > .footer-inner').length ?? 0,
      footerLinks: footerAnchors.map(serializeAnchor),
      footerOutsideMain: footer ? !footer.closest('main') : false,
      footerCount: footerNodes.length,
      footerNavigationCount: footerNavigation.length,
      footerExternalAnchorCount: footerAnchors.filter((anchor) => /^https?:/i.test(anchor.getAttribute('href') ?? '')).length,
      h1s: [...document.querySelectorAll('h1')].map((heading) => heading.textContent?.trim() ?? ''),
      origin: location.origin,
      title: document.title,
    }
  })()`)

  assert(pageContract.title === EXPECTED_TITLE, `Unexpected document title: ${JSON.stringify(pageContract.title)}`)
  assert(pageContract.canonicalCount === 1 && pageContract.canonical === EXPECTED_CANONICAL, `Unexpected canonical URL: ${JSON.stringify(pageContract)}`)
  assert(pageContract.descriptionCount === 1 && pageContract.description === EXPECTED_DESCRIPTION && pageContract.description.length > 0, `Unexpected meta description: ${JSON.stringify(pageContract)}`)
  assert(pageContract.h1s.length === 1 && pageContract.h1s[0] === EXPECTED_H1, `Expected exactly one H1 with the current visible text: ${JSON.stringify(pageContract.h1s)}`)
  assert(pageContract.footerCount === 1, `Expected exactly one site footer: ${JSON.stringify(pageContract)}`)
  assert(pageContract.footerOutsideMain, `Expected the footer to be outside main: ${JSON.stringify(pageContract)}`)
  assert(pageContract.footerInnerCount === 1, `Expected one footer inner row: ${JSON.stringify(pageContract)}`)
  assert(pageContract.footerNavigationCount === 1, `Expected one footer navigation: ${pageContract.footerNavigationCount}`)
  assert(pageContract.footerCopyrightCount === 1, `Expected one footer copyright sibling: ${JSON.stringify(pageContract)}`)
  assert(pageContract.footerCopyright === EXPECTED_FOOTER_COPYRIGHT, `Unexpected footer copyright: ${JSON.stringify(pageContract)}`)
  assert(pageContract.footerLinks.length === expectedFooterLinks.length, `Unexpected footer link count: ${JSON.stringify(pageContract.footerLinks)}`)
  assert(pageContract.externalAnchorCount === 2, `Expected exactly two external anchors: ${JSON.stringify(pageContract)}`)
  assert(pageContract.footerExternalAnchorCount === pageContract.externalAnchorCount, `Expected every external anchor to be in the footer: ${JSON.stringify(pageContract)}`)
  assert(pageContract.externalAnchorOutsideFooterCount === 0, `Found an external anchor outside the footer: ${JSON.stringify(pageContract)}`)

  expectedFooterLinks.forEach((expectedLink, index) => {
    const link = pageContract.footerLinks[index]
    assert(link, `Missing footer link at index ${index}: ${expectedLink.rawHref}`)
    assert(link.rawHref === expectedLink.rawHref, `Unexpected raw footer href at index ${index}: ${JSON.stringify(link)}`)
    assert(link.resolvedHref === new URL(expectedLink.rawHref, pageContract.origin).href, `Unexpected resolved footer href at index ${index}: ${JSON.stringify(link)}`)
    assert(link.text === expectedLink.text && link.text.length > 3, `Footer link text is not descriptive at index ${index}: ${JSON.stringify(link.text)}`)
    if (expectedLink.external) {
      assert(link.target === '_blank', `External footer link must use target=_blank: ${JSON.stringify(link)}`)
      const relTokens = new Set(link.rel.toLowerCase().split(/\s+/).filter(Boolean))
      assert(relTokens.has('noopener') && relTokens.has('noreferrer'), `External footer link is missing safe rel tokens: ${JSON.stringify(link)}`)
    } else {
      assert(link.target !== '_blank', `Hub footer link must stay in the same tab: ${JSON.stringify(link)}`)
    }
  })
}

async function runStaticContentRegression({ basePath, cdp, origin, pageUrl }) {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const targetId = target.targetId
  let sessionId
  try {
    const attached = await cdp.send('Target.attachToTarget', { flatten: true, targetId })
    sessionId = attached.sessionId
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId)

    await cdp.send('Page.navigate', { url: pageUrl }, sessionId)
    await waitForDom(cdp, sessionId, `document.readyState === 'complete' && document.querySelector('.static-content') !== null`, 'the static app content with scripts disabled')
    const appState = await evaluate(cdp, sessionId, `(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const section = document.querySelector('.static-content')
      const heading = section?.querySelector('#static-content-title')
      const guideAnchor = section?.querySelector('a[href$="guide.html"]')
      return {
        guideAnchorHref: guideAnchor?.href ?? '',
        guideAnchorText: guideAnchor?.textContent?.trim() ?? '',
        guideAnchorVisible: isVisible(guideAnchor),
        headingText: heading?.textContent?.trim() ?? '',
        sectionVisible: isVisible(section),
      }
    })()`)
    assert(appState.sectionVisible && appState.headingText === 'ブラウザ内で画像を整える', `Static app section is not visible with scripts disabled: ${JSON.stringify(appState)}`)
    assert(appState.guideAnchorVisible && appState.guideAnchorText === '使い方ガイド' && appState.guideAnchorHref === `${origin}${basePath}guide.html`, `Static guide anchor is not visible or does not resolve under BASE_PATH: ${JSON.stringify(appState)}`)
    await captureScreenshot(cdp, sessionId, 'no-js-app-mobile.png')

    await cdp.send('Page.navigate', { url: `${origin}${basePath}guide.html` }, sessionId)
    await waitForDom(cdp, sessionId, `document.readyState === 'complete' && document.querySelector('h1')?.textContent?.trim() === '画像圧縮・編集の使い方' && document.querySelector('#faq-title') !== null`, 'the static guide with scripts disabled')
    const guideState = await evaluate(cdp, sessionId, `(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const documentElement = document.documentElement
      const body = document.body
      const heading = document.querySelector('h1')
      const faqHeading = document.querySelector('#faq-title')
      const faqSummary = document.querySelector('#faq-title')?.parentElement?.querySelector('summary')
      return {
        faqHeadingText: faqHeading?.textContent?.trim() ?? '',
        faqHeadingVisible: isVisible(faqHeading),
        faqSummaryText: faqSummary?.textContent?.trim() ?? '',
        faqSummaryVisible: isVisible(faqSummary),
        headingText: heading?.textContent?.trim() ?? '',
        headingVisible: isVisible(heading),
        horizontalScrollWidth: Math.max(documentElement.scrollWidth, body?.scrollWidth ?? 0),
        viewportWidth: window.innerWidth,
        viewportClientWidth: documentElement.clientWidth,
      }
    })()`)
    assert(guideState.headingVisible && guideState.headingText === '画像圧縮・編集の使い方', `Static guide heading is not readable with scripts disabled: ${JSON.stringify(guideState)}`)
    assert(guideState.faqHeadingVisible && guideState.faqHeadingText === 'よくある質問' && guideState.faqSummaryVisible && guideState.faqSummaryText.length > 0, `Static guide FAQ is not readable with scripts disabled: ${JSON.stringify(guideState)}`)
    assert(guideState.viewportWidth === MOBILE_VIEWPORT.width && guideState.horizontalScrollWidth <= guideState.viewportClientWidth + 1, `Static guide overflows horizontally at mobile width: ${JSON.stringify(guideState)}`)
    await captureScreenshot(cdp, sessionId, 'no-js-guide-mobile.png')
    return { app: appState, guide: guideState }
  } finally {
    if (sessionId) {
      try {
        await cdp.send('Emulation.setScriptExecutionDisabled', { value: false }, sessionId)
      } catch {
        // The isolated target may already be gone after a failed navigation.
      }
    }
    try {
      await cdp.send('Target.closeTarget', { targetId })
    } catch {
      // Chrome may already have exited after a failed test.
    }
  }
}

async function clickButton(cdp, sessionId, text) {
  const quotedText = JSON.stringify(text)
  await evaluate(cdp, sessionId, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(${quotedText}))
    if (!button) throw new Error('Button not found: ' + ${quotedText})
    if (button.disabled) throw new Error('Button is disabled: ' + button.textContent)
    button.click()
    return button.textContent?.trim()
  })()`)
}

async function setControlValue(cdp, sessionId, selector, value) {
  const quotedSelector = JSON.stringify(selector)
  const quotedValue = JSON.stringify(String(value))
  await evaluate(cdp, sessionId, `(() => {
    const element = document.querySelector(${quotedSelector})
    if (!element) throw new Error('Control not found: ' + ${quotedSelector})
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (!setter) throw new Error('Control value setter is unavailable: ' + ${quotedSelector})
    setter.call(element, ${quotedValue})
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return element.value
  })()`)
}

async function runAspectAndGuideRegression({ cdp, sessionId }) {
  const closedAdvancedState = await evaluate(cdp, sessionId, `(() => {
    const details = document.querySelector('.advanced-controls')
    const select = document.querySelector('#aspect-ratio')
    const rect = select?.getBoundingClientRect()
    return {
      advancedOpen: details?.open ?? null,
      inOutputCard: select?.closest('.output-card') !== null,
      value: select?.value ?? '',
      visible: Boolean(rect && rect.width > 0 && rect.height > 0),
    }
  })()`)
  assert(closedAdvancedState.advancedOpen === false, `Aspect ratio control was not reachable with advanced controls closed: ${JSON.stringify(closedAdvancedState)}`)
  assert(closedAdvancedState.inOutputCard && closedAdvancedState.visible, `Aspect ratio control was not moved next to output size: ${JSON.stringify(closedAdvancedState)}`)
  assert(closedAdvancedState.value === 'original', `The initial aspect ratio preset changed unexpectedly: ${JSON.stringify(closedAdvancedState)}`)

  const readAspectState = () => evaluate(cdp, sessionId, `(() => {
    const readDimensions = (selector) => {
      const text = document.querySelector(selector)?.textContent?.trim() ?? ''
      const values = text.replace(' px', '').split(' × ').map(Number)
      return values.length === 2 && values.every((value) => Number.isFinite(value))
        ? { width: values[0], height: values[1] }
        : null
    }
    const cropValues = [...document.querySelectorAll('.crop-coordinates input')].map((input) => Number(input.value))
    return {
      aspect: document.querySelector('#aspect-ratio')?.value ?? '',
      crop: cropValues.length === 4 && cropValues.every((value) => Number.isFinite(value))
        ? { x: cropValues[0], y: cropValues[1], width: cropValues[2], height: cropValues[3] }
        : null,
      output: readDimensions('.effective-size strong'),
      previewUrl: document.querySelector('.processed-preview')?.src ?? '',
      rendered: readDimensions('.metrics-card .metric-line:nth-child(3) strong'),
      status: document.querySelector('.status-chip')?.textContent?.trim() ?? '',
    }
  })()`)

  const aspectCases = [
    { label: 'landscape', value: '4:3', ratio: 4 / 3 },
    { label: 'portrait', value: '3:4', ratio: 3 / 4 },
    { label: 'square', value: '1:1', ratio: 1 },
  ]
  const aspectResults = {}
  for (const aspectCase of aspectCases) {
    await setControlValue(cdp, sessionId, '#aspect-ratio', aspectCase.value)
    const state = await waitFor(async () => {
      const next = await readAspectState()
      if (
        next.aspect === aspectCase.value &&
        next.status === 'プレビュー準備完了' &&
        next.crop &&
        next.output &&
        next.rendered &&
        next.previewUrl.startsWith('blob:') &&
        next.output.width === next.rendered.width &&
        next.output.height === next.rendered.height
      ) {
        return next
      }
      throw new Error(`Aspect regression state is not ready: ${JSON.stringify(next)}`)
    }, `${aspectCase.label} aspect crop and output`)
    const cropRatio = state.crop.width / state.crop.height
    const outputRatio = state.output.width / state.output.height
    assert(Math.abs(cropRatio - aspectCase.ratio) <= 0.02, `${aspectCase.label} crop ratio changed unexpectedly: ${JSON.stringify({ state, expected: aspectCase.ratio, actual: cropRatio })}`)
    assert(Math.abs(outputRatio - aspectCase.ratio) <= 0.02, `${aspectCase.label} output ratio changed unexpectedly: ${JSON.stringify({ state, expected: aspectCase.ratio, actual: outputRatio })}`)
    aspectResults[aspectCase.label] = {
      crop: state.crop,
      cropRatio,
      output: state.output,
      outputRatio,
    }
  }

  await clickButton(cdp, sessionId, '編集をリセット')
  await waitForDom(cdp, sessionId, `document.querySelector('#aspect-ratio')?.value === 'original' && [...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value).join(',') === '0,0,16,32' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the original full crop before guide regression')

  const readGuideState = () => evaluate(cdp, sessionId, `(() => {
    const guide = document.querySelector('.crop-guide')
    const crop = document.querySelector('.crop-rectangle')
    const guideRect = guide?.getBoundingClientRect()
    const cropRect = crop?.getBoundingClientRect()
    const style = guide ? getComputedStyle(guide) : null
    return {
      ariaHidden: guide?.getAttribute('aria-hidden') ?? null,
      className: guide?.getAttribute('class') ?? '',
      display: style?.display ?? null,
      guideInsideCrop: Boolean(guideRect && cropRect &&
        guideRect.left >= cropRect.left - 1 &&
        guideRect.right <= cropRect.right + 1 &&
        guideRect.top >= cropRect.top - 1 &&
        guideRect.bottom <= cropRect.bottom + 1),
      pointerEvents: style?.pointerEvents ?? null,
      previewUrl: document.querySelector('.processed-preview')?.src ?? '',
      status: document.querySelector('.status-chip')?.textContent?.trim() ?? '',
      value: document.querySelector('#composition-guide')?.value ?? '',
      visible: Boolean(guideRect && guideRect.width > 0 && guideRect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden'),
    }
  })()`)

  const initialGuideState = await readGuideState()
  assert(initialGuideState.value === 'thirds' && initialGuideState.visible, `Composition guide did not default to thirds: ${JSON.stringify(initialGuideState)}`)
  const guidePreviewUrl = initialGuideState.previewUrl
  const guideBaselinePixels = await capturePixelEvidence(cdp, sessionId)
  const guideResults = {}
  let guideScreenshot
  for (const guideCase of [
    { value: 'thirds', visible: true },
    { value: 'golden', visible: true },
    { value: 'diagonal', visible: true },
    { value: 'none', visible: false },
  ]) {
    await setControlValue(cdp, sessionId, '#composition-guide', guideCase.value)
    const state = await waitFor(async () => {
      const next = await readGuideState()
      if (next.value === guideCase.value && next.status === 'プレビュー準備完了' && next.previewUrl === guidePreviewUrl) {
        return next
      }
      throw new Error(`Composition guide regression state is not ready: ${JSON.stringify(next)}`)
    }, `${guideCase.value} composition guide without preview regeneration`)
    assert(state.ariaHidden === 'true' && state.pointerEvents === 'none', `${guideCase.value} guide is not a passive accessible overlay: ${JSON.stringify(state)}`)
    assert(state.visible === guideCase.visible, `${guideCase.value} guide visibility changed unexpectedly: ${JSON.stringify(state)}`)
    if (guideCase.visible) {
      assert(state.guideInsideCrop, `${guideCase.value} guide escaped the crop rectangle: ${JSON.stringify(state)}`)
    }
    if (guideCase.value === 'golden') {
      guideScreenshot = await captureScreenshot(cdp, sessionId, 'composition-guide-golden.png')
    }
    guideResults[guideCase.value] = state
  }

  const guideAfterPixels = await capturePixelEvidence(cdp, sessionId)
  assert(JSON.stringify(guideAfterPixels.crop) === JSON.stringify(guideBaselinePixels.crop), `Composition guides changed crop geometry: ${JSON.stringify({ before: guideBaselinePixels.crop, after: guideAfterPixels.crop })}`)
  assert(guideAfterPixels.preview.width === guideBaselinePixels.preview.width && guideAfterPixels.preview.height === guideBaselinePixels.preview.height, `Composition guides changed export dimensions: ${JSON.stringify({ before: guideBaselinePixels.preview, after: guideAfterPixels.preview })}`)
  assert(guideAfterPixels.preview.pixels.every((pixel, index) => pixel === guideBaselinePixels.preview.pixels[index]), 'Composition guides changed the rendered preview pixels.')
  assert(guideAfterPixels.stageTransform === guideBaselinePixels.stageTransform, 'Composition guides changed the image transform.')

  await setControlValue(cdp, sessionId, '#composition-guide', 'thirds')
  await waitForDom(cdp, sessionId, `document.querySelector('#composition-guide')?.value === 'thirds' && document.querySelector('.processed-preview')?.src === ${JSON.stringify(guidePreviewUrl)}`, 'the default thirds guide after regression')

  return {
    aspectCases: aspectResults,
    guideCases: guideResults,
    screenshot: guideScreenshot,
  }
}

async function dragCropRectangle(cdp, sessionId, direction) {
  const points = await evaluate(cdp, sessionId, `(() => {
    const surface = document.querySelector('.crop-surface')
    const crop = document.querySelector('.crop-rectangle')
    if (!(surface instanceof HTMLElement) || !(crop instanceof HTMLElement)) {
      throw new Error('Crop surface or crop rectangle is missing.')
    }
    const surfaceRect = surface.getBoundingClientRect()
    const cropRect = crop.getBoundingClientRect()
    const start = {
      x: (cropRect.left + cropRect.right) / 2,
      y: (cropRect.top + cropRect.bottom) / 2,
    }
    const end = ${direction === 'right-bottom'
      ? '{ x: surfaceRect.right - 1, y: surfaceRect.bottom - 1 }'
      : '{ x: surfaceRect.left + 1, y: surfaceRect.top + 1 }'}
    return {
      end,
      midpoint: {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      },
      start,
    }
  })()`)

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: points.start.x,
    y: points.start.y,
    button: 'none',
    buttons: 0,
  }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: points.start.x,
    y: points.start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: points.midpoint.x,
    y: points.midpoint.y,
    button: 'left',
    buttons: 1,
  }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: points.end.x,
    y: points.end.y,
    button: 'left',
    buttons: 1,
  }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: points.end.x,
    y: points.end.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  }, sessionId)
}

async function setPanAndAssertCrop(cdp, sessionId, panX, panY, expectedCrop, description) {
  const previousPreviewUrl = await evaluate(cdp, sessionId, "document.querySelector('.processed-preview')?.src ?? ''")
  await setControlValue(cdp, sessionId, '#pan-x', panX)
  await setControlValue(cdp, sessionId, '#pan-y', panY)
  const expectedCoordinates = [expectedCrop.x, expectedCrop.y, expectedCrop.width, expectedCrop.height].join(',')
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === ${JSON.stringify(expectedCoordinates)} && document.querySelector('#pan-x')?.value === ${JSON.stringify(String(panX))} && document.querySelector('#pan-y')?.value === ${JSON.stringify(String(panY))} && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了' && document.querySelector('.processed-preview')?.src !== ${JSON.stringify(previousPreviewUrl)}`, description)
  const pixels = await capturePixelEvidence(cdp, sessionId)
  const pixelError = assertCropPixelEvidence(`${description} preview`, pixels)
  assert(
    pixels.crop.x === expectedCrop.x && pixels.crop.y === expectedCrop.y && pixels.crop.width === expectedCrop.width && pixels.crop.height === expectedCrop.height,
    `${description} geometry was not adopted: ${JSON.stringify(pixels.crop)}`,
  )
  return { crop: pixels.crop, pixelError }
}

async function runCropDragBoundsRegression({ cdp, cropDragFixturePath, downloadDirectory, sessionId }) {
  const fixtureDataUrl = await evaluate(cdp, sessionId, `(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000
    canvas.height = 600
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create a 2D canvas context for the crop drag fixture.')
    const halfWidth = canvas.width / 2
    const halfHeight = canvas.height / 2
    const quadrants = [
      ['#e63946', 0, 0, halfWidth, halfHeight],
      ['#457b9d', halfWidth, 0, halfWidth, halfHeight],
      ['#f4a261', 0, halfHeight, halfWidth, halfHeight],
      ['#2a9d8f', halfWidth, halfHeight, halfWidth, halfHeight],
    ]
    for (const [color, x, y, width, height] of quadrants) {
      context.fillStyle = color
      context.fillRect(x, y, width, height)
    }
    return canvas.toDataURL('image/png')
  })()`)
  const encodedFixture = fixtureDataUrl?.match(/^data:image\/png;base64,(.+)$/)?.[1]
  assert(encodedFixture, 'Crop drag fixture did not encode as a PNG data URL.')
  await writeFile(cropDragFixturePath, Buffer.from(encodedFixture, 'base64'))

  await setFileInput(cdp, sessionId, cropDragFixturePath)
  await waitForDom(cdp, sessionId, `document.querySelector('.metrics-card .metric-line:first-child strong')?.textContent?.trim() === '1000 × 600 px'`, 'the crop drag regression source dimensions')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the crop drag regression initial preview')
  await evaluate(cdp, sessionId, `(() => {
    const details = document.querySelector('.advanced-controls')
    if (!(details instanceof HTMLDetailsElement)) throw new Error('Advanced crop controls are missing.')
    if (!details.open) details.querySelector('summary')?.click()
    return details.open
  })()`)

  await setControlValue(cdp, sessionId, '#aspect-ratio', 'free')
  await waitForDom(cdp, sessionId, `document.querySelector('#aspect-ratio')?.value === 'free'`, 'the free crop aspect ratio')
  const cropInputSelectors = [1, 2, 3, 4].map((index) => `.crop-coordinates label:nth-child(${index}) input`)
  await setControlValue(cdp, sessionId, cropInputSelectors[0], 0)
  await setControlValue(cdp, sessionId, cropInputSelectors[1], 0)
  await setControlValue(cdp, sessionId, cropInputSelectors[2], 400)
  await setControlValue(cdp, sessionId, cropInputSelectors[3], 300)
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '0,0,400,300' && document.querySelector('.effective-size strong')?.textContent?.trim() === '400 × 300 px'`, 'the left-aligned 400 x 300 crop')

  await setControlValue(cdp, sessionId, cropInputSelectors[0], 100)
  await setControlValue(cdp, sessionId, cropInputSelectors[1], 50)
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '100,50,400,300' && document.querySelector('#pan-x')?.value === '0' && document.querySelector('#pan-y')?.value === '0'`, 'the off-center 400 x 300 crop for pan controls')

  const offCenterPanControls = {
    bottom: await setPanAndAssertCrop(cdp, sessionId, 0, 1, { x: 100, y: 300, width: 400, height: 300 }, 'off-center bottom pan endpoint'),
    left: await setPanAndAssertCrop(cdp, sessionId, -1, 0, { x: 0, y: 50, width: 400, height: 300 }, 'off-center left pan endpoint'),
    intermediate: await setPanAndAssertCrop(cdp, sessionId, 0.25, -0.4, { x: 225, y: 30, width: 400, height: 300 }, 'off-center intermediate pan'),
    neutral: await setPanAndAssertCrop(cdp, sessionId, 0, 0, { x: 100, y: 50, width: 400, height: 300 }, 'off-center neutral pan'),
    right: await setPanAndAssertCrop(cdp, sessionId, 1, 0, { x: 600, y: 50, width: 400, height: 300 }, 'off-center right pan endpoint'),
    top: await setPanAndAssertCrop(cdp, sessionId, 0, -1, { x: 100, y: 0, width: 400, height: 300 }, 'off-center top pan endpoint'),
  }

  await setControlValue(cdp, sessionId, '#zoom', '2')
  const zoomedPanControls = {
    bottom: await setPanAndAssertCrop(cdp, sessionId, 0, 1, { x: 200, y: 450, width: 200, height: 150 }, 'zoomed bottom pan endpoint'),
    left: await setPanAndAssertCrop(cdp, sessionId, -1, 0, { x: 0, y: 125, width: 200, height: 150 }, 'zoomed left pan endpoint'),
    intermediate: await setPanAndAssertCrop(cdp, sessionId, 0.25, -0.4, { x: 350, y: 75, width: 200, height: 150 }, 'zoomed intermediate pan'),
    neutral: await setPanAndAssertCrop(cdp, sessionId, 0, 0, { x: 200, y: 125, width: 200, height: 150 }, 'zoomed neutral pan'),
    right: await setPanAndAssertCrop(cdp, sessionId, 1, 0, { x: 800, y: 125, width: 200, height: 150 }, 'zoomed right pan endpoint'),
    top: await setPanAndAssertCrop(cdp, sessionId, 0, -1, { x: 200, y: 0, width: 200, height: 150 }, 'zoomed top pan endpoint'),
  }

  await setControlValue(cdp, sessionId, '#zoom', '1')
  await setPanAndAssertCrop(cdp, sessionId, 0, 0, { x: 100, y: 50, width: 400, height: 300 }, 'off-center neutral pan after zoom reset')
  await setControlValue(cdp, sessionId, cropInputSelectors[0], 0)
  await setControlValue(cdp, sessionId, cropInputSelectors[1], 0)
  await setControlValue(cdp, sessionId, cropInputSelectors[2], 400)
  await setControlValue(cdp, sessionId, cropInputSelectors[3], 300)
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '0,0,400,300' && document.querySelector('#zoom')?.value === '1' && document.querySelector('#pan-x')?.value === '0' && document.querySelector('#pan-y')?.value === '0'`, 'the left-aligned crop restored before pointer dragging')

  await dragCropRectangle(cdp, sessionId, 'right-bottom')
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '600,300,400,300' && document.querySelector('.effective-size strong')?.textContent?.trim() === '400 × 300 px' && document.querySelector('.metrics-card .metric-line:nth-child(3) strong')?.textContent?.trim() === '400 × 300 px' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the crop drag to the right and bottom bounds')
  const rightEdgePixels = await capturePixelEvidence(cdp, sessionId)
  const rightEdgePixelError = assertCropPixelEvidence('right-bottom crop preview', rightEdgePixels)
  assert(rightEdgePixels.crop.x === 600 && rightEdgePixels.crop.y === 300 && rightEdgePixels.crop.width === 400 && rightEdgePixels.crop.height === 300, `Right-bottom crop geometry was not adopted: ${JSON.stringify(rightEdgePixels.crop)}`)
  assert(rightEdgePixels.preview.width === 400 && rightEdgePixels.preview.height === 300, `Right-bottom output dimensions were unexpected: ${JSON.stringify(rightEdgePixels.preview)}`)
  const rightEdgeScreenshot = await captureScreenshot(cdp, sessionId, 'crop-right-bound.png')

  await clickButton(cdp, sessionId, 'ダウンロード')
  const downloadedFilename = 'e2e-crop-drag-edited.jpg'
  const downloadedPath = await waitForDownloadedFile(downloadDirectory, downloadedFilename)
  const outputBytes = new Uint8Array(await readFile(downloadedPath))
  const outputDimensions = parseJpegDimensions(outputBytes)
  assert(outputDimensions.width === 400 && outputDimensions.height === 300, `Right-bottom downloaded output dimensions were ${outputDimensions.width}x${outputDimensions.height}, expected 400x300.`)

  await dragCropRectangle(cdp, sessionId, 'left-top')
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '0,0,400,300' && document.querySelector('.metrics-card .metric-line:nth-child(3) strong')?.textContent?.trim() === '400 × 300 px' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the crop drag back to the left and top bounds')
  const leftEdgePixels = await capturePixelEvidence(cdp, sessionId)
  const leftEdgePixelError = assertCropPixelEvidence('left-top crop preview', leftEdgePixels)
  assert(leftEdgePixels.crop.x === 0 && leftEdgePixels.crop.y === 0 && leftEdgePixels.crop.width === 400 && leftEdgePixels.crop.height === 300, `Left-top crop geometry was not adopted after reversal: ${JSON.stringify(leftEdgePixels.crop)}`)
  assert(leftEdgePixels.preview.width === 400 && leftEdgePixels.preview.height === 300, `Left-top output dimensions after reversal were unexpected: ${JSON.stringify(leftEdgePixels.preview)}`)

  await dragCropRectangle(cdp, sessionId, 'right-bottom')
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '600,300,400,300' && document.querySelector('.metrics-card .metric-line:nth-child(3) strong')?.textContent?.trim() === '400 × 300 px' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the repeated crop drag to the right and bottom bounds')
  const repeatedRightEdgePixels = await capturePixelEvidence(cdp, sessionId)
  const repeatedRightEdgePixelError = assertCropPixelEvidence('repeated right-bottom crop preview', repeatedRightEdgePixels)

  await setControlValue(cdp, sessionId, cropInputSelectors[0], 100)
  await setControlValue(cdp, sessionId, cropInputSelectors[1], 50)
  await setControlValue(cdp, sessionId, cropInputSelectors[2], 400)
  await setControlValue(cdp, sessionId, cropInputSelectors[3], 300)
  await setControlValue(cdp, sessionId, '#zoom', '2')
  await setControlValue(cdp, sessionId, '#pan-x', '0.25')
  await setControlValue(cdp, sessionId, '#pan-y', '-0.4')
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '350,75,200,150' && document.querySelector('#zoom')?.value === '2' && document.querySelector('#pan-x')?.value === '0.25' && document.querySelector('#pan-y')?.value === '-0.4' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the off-center zoomed crop before pointer dragging')
  const zoomScreenshot = await captureScreenshot(cdp, sessionId, 'crop-zoomed-off-center.png')

  await dragCropRectangle(cdp, sessionId, 'right-bottom')
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '800,450,200,150' && document.querySelector('#zoom')?.value === '1' && document.querySelector('#pan-x')?.value === '0' && document.querySelector('#pan-y')?.value === '0' && document.querySelector('.metrics-card .metric-line:nth-child(3) strong')?.textContent?.trim() === '200 × 150 px' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the zoomed crop drag to the right and bottom bounds')
  const zoomRightEdgePixels = await capturePixelEvidence(cdp, sessionId)
  const zoomRightEdgePixelError = assertCropPixelEvidence('zoomed right-bottom crop preview', zoomRightEdgePixels)

  await dragCropRectangle(cdp, sessionId, 'left-top')
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '0,0,200,150' && document.querySelector('.metrics-card .metric-line:nth-child(3) strong')?.textContent?.trim() === '200 × 150 px' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the reversed zoomed crop drag to the left and top bounds')
  const zoomLeftEdgePixels = await capturePixelEvidence(cdp, sessionId)
  const zoomLeftEdgePixelError = assertCropPixelEvidence('zoomed left-top crop preview', zoomLeftEdgePixels)

  await dragCropRectangle(cdp, sessionId, 'right-bottom')
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '800,450,200,150' && document.querySelector('.metrics-card .metric-line:nth-child(3) strong')?.textContent?.trim() === '200 × 150 px' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the repeated zoomed crop drag to the right and bottom bounds')
  const repeatedZoomRightEdgePixels = await capturePixelEvidence(cdp, sessionId)
  const repeatedZoomRightEdgePixelError = assertCropPixelEvidence('repeated zoomed right-bottom crop preview', repeatedZoomRightEdgePixels)

  return {
    leftEdge: leftEdgePixels.crop,
    output: outputDimensions,
    panControls: { offCenter: offCenterPanControls, zoomed: zoomedPanControls },
    repeatedRightEdge: repeatedRightEdgePixels.crop,
    rightEdge: rightEdgePixels.crop,
    pixelEvidence: {
      leftEdge: leftEdgePixelError,
      repeatedRightEdge: repeatedRightEdgePixelError,
      repeatedZoomRightEdge: repeatedZoomRightEdgePixelError,
      rightEdge: rightEdgePixelError,
      zoomLeftEdge: zoomLeftEdgePixelError,
      zoomRightEdge: zoomRightEdgePixelError,
    },
    screenshots: { rightBound: rightEdgeScreenshot, zoomedOffCenter: zoomScreenshot },
    zoomLeftEdge: zoomLeftEdgePixels.crop,
    zoomRightEdge: zoomRightEdgePixels.crop,
  }
}

async function setFileInput(cdp, sessionId, filePath) {
  const documentResult = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId)
  const queryResult = await cdp.send('DOM.querySelector', {
    nodeId: documentResult.root.nodeId,
    selector: 'input[type="file"]',
  }, sessionId)
  assert(queryResult.nodeId, 'The real file input was not found.')
  await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId: queryResult.nodeId }, sessionId)
}

async function dispatchFileDrop(cdp, sessionId, selector, filePath, filename = basename(filePath)) {
  const encodedFile = (await readFile(filePath)).toString('base64')
  const quotedSelector = JSON.stringify(selector)
  const quotedFilename = JSON.stringify(filename)
  const quotedEncodedFile = JSON.stringify(encodedFile)

  await evaluate(cdp, sessionId, `(() => {
    const target = document.querySelector(${quotedSelector})
    if (!(target instanceof HTMLElement)) throw new Error('Drop target not found: ' + ${quotedSelector})
    const bytes = Uint8Array.from(atob(${quotedEncodedFile}), (character) => character.charCodeAt(0))
    const file = new File([bytes], ${quotedFilename}, { type: 'image/jpeg' })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
  })()`)
  await waitForDom(cdp, sessionId, `document.querySelector(${quotedSelector})?.classList.contains('is-dragging') === true`, `drag-over feedback for ${selector}`)

  await evaluate(cdp, sessionId, `(() => {
    const target = document.querySelector(${quotedSelector})
    if (!(target instanceof HTMLElement)) throw new Error('Drop target not found: ' + ${quotedSelector})
    target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
  })()`)
  await waitForDom(cdp, sessionId, `document.querySelector(${quotedSelector})?.classList.contains('is-dragging') === false`, `drag-leave feedback for ${selector}`)

  await evaluate(cdp, sessionId, `(() => {
    const target = document.querySelector(${quotedSelector})
    if (!(target instanceof HTMLElement)) throw new Error('Drop target not found: ' + ${quotedSelector})
    const bytes = Uint8Array.from(atob(${quotedEncodedFile}), (character) => character.charCodeAt(0))
    const file = new File([bytes], ${quotedFilename}, { type: 'image/jpeg' })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
  })()`)
  await waitForDom(cdp, sessionId, `document.querySelector(${quotedSelector})?.classList.contains('is-dragging') === true`, `drag-over reactivation for ${selector}`)

  await evaluate(cdp, sessionId, `(() => {
    const target = document.querySelector(${quotedSelector})
    if (!(target instanceof HTMLElement)) throw new Error('Drop target not found: ' + ${quotedSelector})
    const bytes = Uint8Array.from(atob(${quotedEncodedFile}), (character) => character.charCodeAt(0))
    const file = new File([bytes], ${quotedFilename}, { type: 'image/jpeg' })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })()`)
  await waitForDom(cdp, sessionId, `(() => {
    const target = document.querySelector(${quotedSelector})
    return target === null || !target.classList.contains('is-dragging')
  })()`, `drop feedback clear for ${selector}`)
}

async function getTargetInfo(cdp, targetId) {
  const result = await cdp.send('Target.getTargets')
  return result.targetInfos.find((target) => target.targetId === targetId)
}

function formatNetworkReport(requests) {
  const originCounts = new Map()
  for (const request of requests) {
    const origin = originForRequest(request.url)
    originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1)
  }
  return {
    httpRequests: requests.filter((request) => request.kind === 'http').length,
    origins: Object.fromEntries([...originCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    requests,
    websocketRequests: requests.filter((request) => request.kind === 'websocket').length,
  }
}

async function waitForDownloadedFile(downloadDirectory, filename) {
  const filePath = join(downloadDirectory, filename)
  await waitFor(async () => {
    try {
      const fileInfo = await stat(filePath)
      return fileInfo.isFile() && fileInfo.size > 0
    } catch {
      return false
    }
  }, `download ${filename}`)
  return filePath
}

function mapDisplayPixelToSource(
  sourceSize,
  crop,
  rotation,
  flipHorizontal,
  flipVertical,
  outputX,
  outputY,
  outputSize,
  horizontalBeforeRotation = false,
) {
  const displaySize = rotation === 90 || rotation === 270
    ? { width: sourceSize.height, height: sourceSize.width }
    : sourceSize
  let displayX = crop.x + Math.floor(outputX * crop.width / outputSize.width)
  let displayY = crop.y + Math.floor(outputY * crop.height / outputSize.height)

  if (horizontalBeforeRotation) {
    if (flipVertical) {
      displayY = displaySize.height - 1 - displayY
    }
  } else {
    if (flipHorizontal) {
      displayX = displaySize.width - 1 - displayX
    }
    if (flipVertical) {
      displayY = displaySize.height - 1 - displayY
    }
  }

  let sourceX
  let sourceY
  switch (rotation) {
    case 0:
      sourceX = displayX
      sourceY = displayY
      break
    case 90:
      sourceX = displayY
      sourceY = sourceSize.height - 1 - displayX
      break
    case 180:
      sourceX = sourceSize.width - 1 - displayX
      sourceY = sourceSize.height - 1 - displayY
      break
    case 270:
      sourceX = sourceSize.width - 1 - displayY
      sourceY = displayX
      break
    default:
      throw new Error(`Unsupported E2E rotation: ${rotation}`)
  }

  if (horizontalBeforeRotation && flipHorizontal) {
    sourceX = sourceSize.width - 1 - sourceX
  }
  return { x: sourceX, y: sourceY }
}

function computeExpectedPixels(source, crop, state, outputSize, horizontalBeforeRotation = false) {
  const expected = new Uint8ClampedArray(outputSize.width * outputSize.height * 4)
  for (let outputY = 0; outputY < outputSize.height; outputY += 1) {
    for (let outputX = 0; outputX < outputSize.width; outputX += 1) {
      const sourcePoint = mapDisplayPixelToSource(
        { width: source.width, height: source.height },
        crop,
        state.rotation,
        state.flipHorizontal,
        state.flipVertical,
        outputX,
        outputY,
        outputSize,
        horizontalBeforeRotation,
      )
      const sourceOffset = (sourcePoint.y * source.width + sourcePoint.x) * 4
      const outputOffset = (outputY * outputSize.width + outputX) * 4
      expected[outputOffset] = source.pixels[sourceOffset]
      expected[outputOffset + 1] = source.pixels[sourceOffset + 1]
      expected[outputOffset + 2] = source.pixels[sourceOffset + 2]
      expected[outputOffset + 3] = source.pixels[sourceOffset + 3]
    }
  }
  return expected
}

function summarizePixelError(actual, expected) {
  assert(actual.length === expected.length, `Pixel buffer lengths differ: ${actual.length} vs ${expected.length}.`)
  let totalAbsoluteError = 0
  let maximumChannelError = 0
  let pixelsOverTolerance = 0
  const pixelCount = actual.length / 4
  for (let offset = 0; offset < actual.length; offset += 4) {
    let pixelAbsoluteError = 0
    for (let channel = 0; channel < 3; channel += 1) {
      const absoluteError = Math.abs(actual[offset + channel] - expected[offset + channel])
      totalAbsoluteError += absoluteError
      pixelAbsoluteError += absoluteError
      maximumChannelError = Math.max(maximumChannelError, absoluteError)
    }
    if (pixelAbsoluteError / 3 > 48) {
      pixelsOverTolerance += 1
    }
  }
  return {
    meanAbsoluteRgbError: totalAbsoluteError / (pixelCount * 3),
    maximumChannelError,
    pixelsOver48Fraction: pixelsOverTolerance / pixelCount,
  }
}

function assertJpegPixelEvidence(label, actual, expected) {
  // JPEG quality 0.57 is lossy: allow RGB MAE <= 28 and <=30% of pixels above
  // a per-pixel RGB error of 48, while preserving the mapping-level evidence.
  const error = summarizePixelError(actual, expected)
  assert(
    error.meanAbsoluteRgbError <= 28 && error.pixelsOver48Fraction <= 0.3,
    `${label} exceeded the documented JPEG tolerance: ${JSON.stringify(error)}`,
  )
  return error
}

function assertCropPixelEvidence(label, evidence) {
  const expected = computeExpectedPixels(
    evidence.source,
    evidence.crop,
    { rotation: 0, flipHorizontal: false, flipVertical: false },
    evidence.preview,
  )
  return assertJpegPixelEvidence(
    label,
    new Uint8ClampedArray(evidence.preview.pixels),
    expected,
  )
}

function assertMappingSeparation(label, expectedError, wrongMappingError) {
  assert(
    wrongMappingError.meanAbsoluteRgbError >= expectedError.meanAbsoluteRgbError + 20,
    `${label} did not separate the wrong mapping: expected=${JSON.stringify(expectedError)}, wrong=${JSON.stringify(wrongMappingError)}`,
  )
}

async function capturePixelEvidence(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const loadImage = (url) => new Promise((resolvePromise, reject) => {
      const image = new Image()
      image.onload = () => resolvePromise(image)
      image.onerror = () => reject(new Error('E2E image decode failed: ' + url))
      image.src = url
    })
    const drawPixels = async (url) => {
      const image = await loadImage(url)
      const width = image.naturalWidth
      const height = image.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('E2E temporary canvas context is unavailable.')
      context.drawImage(image, 0, 0, width, height)
      return { width, height, pixels: Array.from(context.getImageData(0, 0, width, height).data) }
    }
    const sourceImage = document.querySelector('.stage-image')
    const previewImage = document.querySelector('.processed-preview')
    if (!sourceImage?.src || !previewImage?.src) throw new Error('E2E source or Worker preview image is missing.')
    const cropValues = [...document.querySelectorAll('.crop-coordinates input')].map((input) => Number(input.value))
    return Promise.all([drawPixels(sourceImage.src), drawPixels(previewImage.src)]).then(([source, preview]) => ({
      crop: { x: cropValues[0], y: cropValues[1], width: cropValues[2], height: cropValues[3] },
      preview,
      source,
      stageTransform: sourceImage.style.transform,
    }))
  })()`)
}

async function runComparisonHoldRegression({ cdp, sessionId }) {
  const readState = () => evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('.comparison-hold-button')
    const processed = document.querySelector('.processed-preview')
    const label = document.querySelector('.stage-preview-label')
    const crop = document.querySelector('.crop-rectangle')
    const processedRect = processed?.getBoundingClientRect()
    const cropRect = crop?.getBoundingClientRect()
    const processedStyle = processed ? getComputedStyle(processed) : null
    return {
      buttonDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
      buttonText: button?.textContent?.trim() ?? '',
      crop: cropRect ? {
        bottom: cropRect.bottom,
        left: cropRect.left,
        right: cropRect.right,
        top: cropRect.top,
      } : null,
      label: label?.textContent?.trim() ?? '',
      processedCount: document.querySelectorAll('.processed-preview').length,
      processed: processedRect && processedStyle ? {
        bottom: processedRect.bottom,
        left: processedRect.left,
        naturalHeight: processed instanceof HTMLImageElement ? processed.naturalHeight : 0,
        naturalWidth: processed instanceof HTMLImageElement ? processed.naturalWidth : 0,
        right: processedRect.right,
        top: processedRect.top,
        visibility: processedStyle.visibility,
      } : null,
    }
  })()`)

  const assertCompressed = async (description) => {
    const state = await waitFor(() => readState().then((next) => next.label === '圧縮後' && next.processed?.visibility === 'visible' ? next : false), description)
    assert(state.processedCount === 1 && state.buttonDisabled === false, `${description} did not restore the processed preview: ${JSON.stringify(state)}`)
    assert(state.crop && state.processed && Math.abs(state.crop.left - state.processed.left) <= 1 && Math.abs(state.crop.right - state.processed.right) <= 1 && Math.abs(state.crop.top - state.processed.top) <= 1 && Math.abs(state.crop.bottom - state.processed.bottom) <= 1, `${description} changed processed/crop alignment: ${JSON.stringify(state)}`)
    return state
  }

  const buttonPoint = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('.comparison-hold-button')
    if (!(button instanceof HTMLElement)) throw new Error('Comparison hold button is missing.')
    const rect = button.getBoundingClientRect()
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
  })()`)
  assert(buttonPoint, 'Comparison hold button has no measurable position.')

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: buttonPoint.x,
    y: buttonPoint.y,
    button: 'none',
    buttons: 0,
  }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: buttonPoint.x,
    y: buttonPoint.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  }, sessionId)
  await waitForDom(cdp, sessionId, "document.querySelector('.stage-preview-label')?.textContent?.trim() === '元画像' && document.querySelector('.processed-preview') && getComputedStyle(document.querySelector('.processed-preview')).visibility === 'hidden'", 'pointer hold to show the original')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 2,
    y: 2,
    button: 'left',
    buttons: 1,
  }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: 2,
    y: 2,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  }, sessionId)
  const pointerRelease = await assertCompressed('pointer release outside the hold control')

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: buttonPoint.x,
    y: buttonPoint.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  }, sessionId)
  await waitForDom(cdp, sessionId, "document.querySelector('.stage-preview-label')?.textContent?.trim() === '元画像'", 'pointer hold before cancel')
  const cancelState = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('.comparison-hold-button')
    if (!(button instanceof HTMLElement)) throw new Error('Comparison hold button is missing for cancel.')
    return button.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
    }))
  })()`)
  assert(cancelState === true, `Pointer cancel event was not dispatched: ${cancelState}`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: buttonPoint.x,
    y: buttonPoint.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  }, sessionId)
  const pointerCancel = await assertCompressed('pointer cancel')

  for (const key of [' ', 'Enter']) {
    await evaluate(cdp, sessionId, `(() => {
      const button = document.querySelector('.comparison-hold-button')
      if (!(button instanceof HTMLElement)) throw new Error('Comparison hold button is missing for keyboard hold.')
      button.focus()
      button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ${JSON.stringify(key)} }))
    })()`)
    await waitForDom(cdp, sessionId, "document.querySelector('.stage-preview-label')?.textContent?.trim() === '元画像'", `keyboard ${key === ' ' ? 'Space' : 'Enter'} hold`)
    await evaluate(cdp, sessionId, `(() => {
      const button = document.querySelector('.comparison-hold-button')
      button?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ${JSON.stringify(key)} }))
    })()`)
    await assertCompressed(`keyboard ${key === ' ' ? 'Space' : 'Enter'} release`)
  }

  await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('.comparison-hold-button')
    if (!(button instanceof HTMLElement)) throw new Error('Comparison hold button is missing for blur.')
    button.focus()
    button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' }))
    return document.querySelector('.stage-preview-label')?.textContent?.trim()
  })()`)
  await waitForDom(cdp, sessionId, "document.querySelector('.stage-preview-label')?.textContent?.trim() === '元画像'", 'keyboard hold before window blur')
  await evaluate(cdp, sessionId, 'window.dispatchEvent(new Event("blur"))')
  const windowBlur = await assertCompressed('window blur release')

  await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${MOBILE_VIEWPORT.width} && window.innerHeight === ${MOBILE_VIEWPORT.height}`, 'the touch comparison viewport')
  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0)')
  const touchPoint = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('.comparison-hold-button')
    if (!(button instanceof HTMLElement)) throw new Error('Comparison hold button is missing for touch.')
    const rect = button.getBoundingClientRect()
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
  })()`)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x: touchPoint.x, y: touchPoint.y, radiusX: 4, radiusY: 4, force: 1 }],
  }, sessionId)
  await waitForDom(cdp, sessionId, "document.querySelector('.stage-preview-label')?.textContent?.trim() === '元画像'", 'touch hold to show the original')
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId)
  const touchRelease = await assertCompressed('touch release')
  const contextMenuPrevented = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('.comparison-hold-button')
    if (!(button instanceof HTMLElement)) throw new Error('Comparison hold button is missing for context menu.')
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    const dispatched = button.dispatchEvent(event)
    return { defaultPrevented: event.defaultPrevented, dispatched }
  })()`)
  assert(contextMenuPrevented.defaultPrevented && contextMenuPrevented.dispatched === false, `Touch comparison allowed a context menu: ${JSON.stringify(contextMenuPrevented)}`)

  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport after comparison hold checks')
  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0)')
  return {
    contextMenuPrevented,
    keyboard: true,
    pointerCancel,
    pointerRelease,
    touchRelease,
    windowBlur,
  }
}

async function runTransparencyComparisonRegression({ cdp, sessionId, fixturePath }) {
  const fixtureDataUrl = await evaluate(cdp, sessionId, `(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create a 2D canvas context for the transparency fixture.')
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#e63946'
    context.fillRect(0, 0, 4, canvas.height)
    return canvas.toDataURL('image/png')
  })()`)
  const encodedFixture = fixtureDataUrl?.match(/^data:image\/png;base64,(.+)$/)?.[1]
  assert(encodedFixture, 'Transparency fixture did not encode as a PNG data URL.')
  await writeFile(fixturePath, Buffer.from(encodedFixture, 'base64'))
  await setControlValue(cdp, sessionId, '#output-format', 'image/png')
  await waitForDom(cdp, sessionId, `document.querySelector('#output-format')?.value === 'image/png'`, 'the PNG output format for transparency comparison')
  await setFileInput(cdp, sessionId, fixturePath)
  await waitForDom(cdp, sessionId, `document.querySelector('.metrics-card .metric-line:first-child strong')?.textContent?.trim() === '8 × 8 px'`, 'the transparency fixture source dimensions')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了' && document.querySelector('.processed-preview')?.src.startsWith('blob:') === true`, 'the transparent PNG processed preview')

  const evidence = await evaluate(cdp, sessionId, `(async () => {
    const source = document.querySelector('.stage-image')
    const preview = document.querySelector('.processed-preview')
    const crop = document.querySelector('.crop-rectangle')
    if (!(source instanceof HTMLImageElement) || !(preview instanceof HTMLImageElement) || !(crop instanceof HTMLElement)) {
      throw new Error('Transparency comparison stage images are missing.')
    }
    if (!preview.complete || preview.naturalWidth === 0 || preview.naturalHeight === 0) {
      await new Promise((resolve, reject) => {
        const handleLoad = () => {
          cleanup()
          resolve()
        }
        const handleError = () => {
          cleanup()
          reject(new Error('Transparency comparison preview image failed to load.'))
        }
        const cleanup = () => {
          preview.removeEventListener('load', handleLoad)
          preview.removeEventListener('error', handleError)
        }
        preview.addEventListener('load', handleLoad, { once: true })
        preview.addEventListener('error', handleError, { once: true })
      })
    }
    if (!preview.complete || preview.naturalWidth === 0 || preview.naturalHeight === 0) {
      throw new Error('Transparency comparison preview image has no natural dimensions.')
    }
    const canvas = document.createElement('canvas')
    canvas.width = preview.naturalWidth
    canvas.height = preview.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Transparency comparison canvas context is unavailable.')
    context.drawImage(preview, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const previewRect = preview.getBoundingClientRect()
    const cropRect = crop.getBoundingClientRect()
    const style = getComputedStyle(preview)
    const transparentPixelOffset = ((canvas.width - 1) * 4)
    const opaqueRedPixelOffset = 0
    return {
      cropRect: { bottom: cropRect.bottom, left: cropRect.left, right: cropRect.right, top: cropRect.top },
      hasOpaqueBase: style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundImage !== 'none',
      natural: { height: preview.naturalHeight, width: preview.naturalWidth },
      previewRect: { bottom: previewRect.bottom, left: previewRect.left, right: previewRect.right, top: previewRect.top },
      opaqueRedPixel: {
        alpha: pixels[opaqueRedPixelOffset + 3],
        blue: pixels[opaqueRedPixelOffset + 2],
        green: pixels[opaqueRedPixelOffset + 1],
        red: pixels[opaqueRedPixelOffset],
      },
      transparentPixel: {
        alpha: pixels[transparentPixelOffset + 3],
        red: pixels[transparentPixelOffset],
      },
      sourceNatural: { height: source.naturalHeight, width: source.naturalWidth },
    }
  })()`)
  assert(evidence.transparentPixel.alpha === 0, `The transparency fixture did not retain a transparent right-half output pixel: ${JSON.stringify(evidence)}`)
  assert(evidence.opaqueRedPixel.alpha === 255 && evidence.opaqueRedPixel.red === 230 && evidence.opaqueRedPixel.green === 57 && evidence.opaqueRedPixel.blue === 70, `The transparency fixture did not retain its opaque red left-half output pixel: ${JSON.stringify(evidence)}`)
  assert(evidence.hasOpaqueBase, `The processed preview has no opaque checker/base for transparent pixels: ${JSON.stringify(evidence)}`)
  assert(evidence.natural.width === 8 && evidence.natural.height === 8, `The transparent preview natural size was unexpected: ${JSON.stringify(evidence)}`)
  assert(Math.abs(evidence.previewRect.left - evidence.cropRect.left) <= 1 && Math.abs(evidence.previewRect.right - evidence.cropRect.right) <= 1 && Math.abs(evidence.previewRect.top - evidence.cropRect.top) <= 1 && Math.abs(evidence.previewRect.bottom - evidence.cropRect.bottom) <= 1, `The transparent processed preview escaped the crop rectangle: ${JSON.stringify(evidence)}`)
  return evidence
}

async function runScenario({ allowedPaths, basePath, cropDragFixturePath, downloadDirectory, fixturePath, layoutFixtures, pageUrl, origin, requestLog, cdp, sessionId, targetId, sourceFamilies, sourceOrientation, transparencyFixturePath }) {
  const diagnostics = new BrowserDiagnostics(cdp, sessionId)
  const network = new NetworkRecorder(cdp, sessionId)
  const screenshots = {}

  await cdp.send('Network.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Log.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await evaluate(cdp, sessionId, `(() => {
    window.addEventListener('error', (event) => console.error('[e2e] window error', event.error?.stack || event.message))
    window.addEventListener('unhandledrejection', (event) => console.error('[e2e] unhandled rejection', event.reason?.stack || String(event.reason)))
  })()`)

  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await cdp.send('Page.navigate', { url: pageUrl }, sessionId)
  await waitForDom(cdp, sessionId, `document.readyState === 'complete' && document.querySelector('input[type="file"]') !== null`, 'the built app to load')
  await assertPublicMetadataAndFooter(cdp, sessionId, basePath)
  await assertEmptyFirstView(cdp, sessionId, DESKTOP_VIEWPORT, 'desktop')
  screenshots.emptyDesktop = await captureScreenshot(cdp, sessionId, 'empty-desktop.png')
  await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${MOBILE_VIEWPORT.width} && window.innerHeight === ${MOBILE_VIEWPORT.height}`, 'the empty mobile viewport')
  await assertEmptyFirstView(cdp, sessionId, MOBILE_VIEWPORT, 'mobile')
  screenshots.emptyMobile = await captureScreenshot(cdp, sessionId, 'empty-mobile.png')
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport before initial drop')
  await dispatchFileDrop(cdp, sessionId, '.drop-zone', fixturePath)
  await waitForFileLoad(cdp, sessionId)
  await waitForDom(cdp, sessionId, `document.querySelector('.metrics-card .metric-line:first-child strong')?.textContent?.trim() === '16 × 32 px'`, 'the normalized source dimensions')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the initial Worker preview')
  await assertLoadedFirstView(cdp, sessionId, DESKTOP_VIEWPORT, 'desktop')
  screenshots.loadedDesktop = await captureScreenshot(cdp, sessionId, 'loaded-desktop.png')
  await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${MOBILE_VIEWPORT.width} && window.innerHeight === ${MOBILE_VIEWPORT.height}`, 'the mobile viewport')
  await assertLoadedFirstView(cdp, sessionId, MOBILE_VIEWPORT, 'mobile')
  screenshots.loadedMobile = await captureScreenshot(cdp, sessionId, 'loaded-mobile.png')
  const stageSrcBeforeNativeSelection = await evaluate(cdp, sessionId, "document.querySelector('.stage-image')?.src ?? ''")
  await setFileInput(cdp, sessionId, fixturePath)
  await waitForDom(cdp, sessionId, `(() => {
    const sourceImage = document.querySelector('.stage-image')
    return typeof sourceImage?.src === 'string' && sourceImage.src.length > 0 && sourceImage.src !== ${JSON.stringify(stageSrcBeforeNativeSelection)}
  })()`, 'the native file input to replace the stage image')
  await waitForFileLoad(cdp, sessionId)
  await waitForDom(cdp, sessionId, `document.querySelector('.metrics-card .metric-line:first-child strong')?.textContent?.trim() === '16 × 32 px'`, 'the native file input source dimensions')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the initial Worker preview after native file selection')
  await dispatchFileDrop(cdp, sessionId, '.change-image-button', fixturePath, 'e2e-metadata-fixture-replacement.jpg')
  await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.alt === 'e2e-metadata-fixture-replacement.jpg の編集対象'`, 'the loaded change-image drop replacement')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the replacement Worker preview')
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport after mobile layout checks')
  const tabletSaveLayoutRegression = await runTabletSaveLayoutRegression({ cdp, sessionId })
  const aspectAndGuideRegression = await runAspectAndGuideRegression({ cdp, sessionId })
  if (aspectAndGuideRegression.screenshot) {
    screenshots.compositionGuide = aspectAndGuideRegression.screenshot
  }
  await openDetails(cdp, sessionId, '.advanced-controls')

  const initialLayout = await evaluate(cdp, sessionId, `(() => {
    const surface = document.querySelector('.crop-surface')
    const sourceImage = document.querySelector('.stage-image')
    const rect = surface?.getBoundingClientRect()
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    return {
      sourceDimensions: document.querySelector('.metrics-card .metric-line:first-child strong')?.textContent?.trim(),
      sourceNaturalHeight: sourceImage?.naturalHeight,
      sourceNaturalWidth: sourceImage?.naturalWidth,
      surfaceHeight: rect?.height,
      surfaceRatio: rect ? rect.width / rect.height : undefined,
      surfaceWidth: rect?.width,
      stageAreaHeight: document.querySelector('.stage-area')?.getBoundingClientRect().height,
      rootFontSize,
    }
  })()`)
  assert(initialLayout.sourceDimensions === '16 × 32 px', `App source dimensions were not normalized: ${JSON.stringify(initialLayout)}`)
  assert(initialLayout.sourceNaturalWidth === 16 && initialLayout.sourceNaturalHeight === 32, `Source img natural dimensions were not normalized: ${JSON.stringify(initialLayout)}`)
  assert(Math.abs(initialLayout.surfaceRatio - 0.5) <= 0.01, `Portrait crop surface ratio was not preserved: ${JSON.stringify(initialLayout)}`)
  assert(initialLayout.stageAreaHeight >= 500, `Desktop stage area is not large enough for the full-window editor: ${JSON.stringify(initialLayout)}`)
  assert(initialLayout.surfaceHeight > 320, `Desktop portrait crop surface did not grow beyond the retired height cap: ${JSON.stringify(initialLayout)}`)

  await setControlValue(cdp, sessionId, '#aspect-ratio', '1:1')
  await waitForDom(cdp, sessionId, `document.querySelector('#aspect-ratio')?.value === '1:1'`, 'the 1:1 preset')
  await waitForDom(cdp, sessionId, `[...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value).join(',') === '0,8,16,16'`, 'the centered 1:1 crop')
  await clickButton(cdp, sessionId, '右へ90°')
  await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.style.transform === 'translate(-50%, -50%) scaleX(1) scaleY(1) rotate(90deg)'`, 'the right 90-degree rotation')
  await waitForDom(cdp, sessionId, `[...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value).join(',') === '8,0,16,16'`, 'the centered crop after rotation')
  await clickButton(cdp, sessionId, '左右反転')
  await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.style.transform === 'translate(-50%, -50%) scaleX(-1) scaleY(1) rotate(90deg)'`, 'the 90-degree horizontal final-axis flip order')
  await waitForDom(cdp, sessionId, `[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('左右反転'))?.classList.contains('is-selected') && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the horizontal flip preview')

  const intermediatePixels = await capturePixelEvidence(cdp, sessionId)
  assert(intermediatePixels.source.width === 16 && intermediatePixels.source.height === 32, `Intermediate source canvas dimensions were not normalized: ${JSON.stringify(intermediatePixels.source)}`)
  assert(intermediatePixels.preview.width === 16 && intermediatePixels.preview.height === 16, `Intermediate preview dimensions were unexpected: ${JSON.stringify(intermediatePixels.preview)}`)
  const intermediateState = { rotation: 90, flipHorizontal: true, flipVertical: false }
  const intermediateExpected = computeExpectedPixels(
    intermediatePixels.source,
    intermediatePixels.crop,
    intermediateState,
    intermediatePixels.preview,
  )
  const intermediateWrongMapping = computeExpectedPixels(
    intermediatePixels.source,
    intermediatePixels.crop,
    intermediateState,
    intermediatePixels.preview,
    true,
  )
  const intermediateError = assertJpegPixelEvidence('90-degree horizontal-flip preview', new Uint8ClampedArray(intermediatePixels.preview.pixels), intermediateExpected)
  const intermediateWrongError = summarizePixelError(new Uint8ClampedArray(intermediatePixels.preview.pixels), intermediateWrongMapping)
  assertMappingSeparation('90-degree horizontal-flip order', intermediateError, intermediateWrongError)

  await clickButton(cdp, sessionId, '上下反転')
  await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.style.transform === 'translate(-50%, -50%) scaleX(-1) scaleY(-1) rotate(90deg)' && [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('上下反転'))?.classList.contains('is-selected') && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了' && document.querySelector('.processed-preview')?.src.startsWith('blob:') === true`, 'the vertical flip')
  const qualityPreviewBefore = await evaluate(cdp, sessionId, `(() => {
    const image = document.querySelector('.processed-preview')
    return image instanceof HTMLImageElement ? { src: image.src } : null
  })()`)
  await setControlValue(cdp, sessionId, '#quality', '0.57')
  await waitForDom(cdp, sessionId, `document.querySelector('#quality')?.value === '0.57' && document.querySelector('output[for="quality"]')?.textContent?.trim() === '57%'`, 'the JPEG quality change')
  const qualityPreviewAfter = await waitFor(async () => {
    const next = await evaluate(cdp, sessionId, `(() => {
      const image = document.querySelector('.processed-preview')
      return {
        bytes: document.querySelector('.metrics-card .metric-line:nth-child(4) strong')?.textContent?.trim() ?? '',
        src: image instanceof HTMLImageElement ? image.src : '',
        status: document.querySelector('.status-chip')?.textContent?.trim() ?? '',
      }
    })()`)
    if (next.status === 'プレビュー準備完了' && next.src.startsWith('blob:') && next.src !== qualityPreviewBefore?.src) {
      return next
    }
    throw new Error(`Quality preview has not updated: ${JSON.stringify(next)}`)
  }, 'the rendered preview after the JPEG quality change')
  assert(qualityPreviewAfter.bytes.length > 0, `The quality change did not produce rendered output metrics: ${JSON.stringify(qualityPreviewAfter)}`)
  await setControlValue(cdp, sessionId, '#resize-width', '16')
  await waitForDom(cdp, sessionId, `document.querySelector('#resize-width')?.value === '16' && document.querySelector('#resize-height')?.value === ''`, 'the width-only resize control')

  const previewState = await waitFor(async () => {
    const domState = await evaluate(cdp, sessionId, `(() => ({
      hasBlobPreview: document.querySelector('.processed-preview')?.src.startsWith('blob:') === true,
      outputSize: document.querySelector('.effective-size strong')?.textContent?.trim(),
      renderedSize: document.querySelector('.metrics-card .metric-line:nth-child(3) strong')?.textContent?.trim(),
      processedPreviewCount: document.querySelectorAll('.processed-preview').length,
      status: document.querySelector('.status-chip')?.textContent?.trim(),
    }))()`)
    const targets = await cdp.send('Target.getTargets')
    const workerTargets = targets.targetInfos
      .filter((target) => target.type === 'worker')
      .map(({ type, url, targetId }) => ({ type, url, targetId }))
    const observedWorkerAssetRequests = network.getObservedHttpRequests().filter((request) => (
      isRasterWorkerAssetPath(new URL(request.url).pathname, basePath)
    ))
    const sameOriginWorkerAssetGets = observedWorkerAssetRequests.filter((request) => (
      request.method === 'GET' &&
      request.hasPostData !== true &&
      request.failed !== true &&
      originForRequest(request.url) === origin
    ))
    const serverWorkerAssetRequests = requestLog.filter((request) => (
      request.method === 'GET' &&
      request.statusCode === 200 &&
      isRasterWorkerAssetPath(request.pathname, basePath)
    ))
    const verifiedWorkerAssetRequests = sameOriginWorkerAssetGets.filter((request) => {
      const pathname = new URL(request.url).pathname
      return serverWorkerAssetRequests.some((serverRequest) => serverRequest.pathname === pathname)
    })
    if (domState.status === 'プレビュー準備完了' && domState.renderedSize === '16 × 16 px' && domState.outputSize === '16 × 16 px' && domState.hasBlobPreview && domState.processedPreviewCount === 1 && workerTargets.length > 0 && verifiedWorkerAssetRequests.length > 0) {
      return {
        domState,
        serverWorkerAssetRequests,
        workerAssetRequests: verifiedWorkerAssetRequests,
        workerTargets,
      }
    }
    throw new Error(`Preview wait diagnostics: ${JSON.stringify({ domState, workerTargets, observedWorkerAssetRequests, sameOriginWorkerAssetGets, serverWorkerAssetRequests, verifiedWorkerAssetRequests, serverRequests: requestLog })}`)
  }, 'a real Worker-generated 16 x 16 preview')

  const finalPixels = await capturePixelEvidence(cdp, sessionId)
  assert(finalPixels.source.width === 16 && finalPixels.source.height === 32, `Final source canvas dimensions were not normalized: ${JSON.stringify(finalPixels.source)}`)
  assert(finalPixels.preview.width === 16 && finalPixels.preview.height === 16, `Final preview dimensions were unexpected: ${JSON.stringify(finalPixels.preview)}`)
  const finalState = { rotation: 90, flipHorizontal: true, flipVertical: true }
  const finalExpected = computeExpectedPixels(finalPixels.source, finalPixels.crop, finalState, finalPixels.preview)
  const finalWrongMapping = computeExpectedPixels(finalPixels.source, finalPixels.crop, finalState, finalPixels.preview, true)
  const finalError = assertJpegPixelEvidence('final rotate-and-double-flip preview', new Uint8ClampedArray(finalPixels.preview.pixels), finalExpected)
  const finalWrongError = summarizePixelError(new Uint8ClampedArray(finalPixels.preview.pixels), finalWrongMapping)
  assertMappingSeparation('final single-axis rotation-order mutation', finalError, finalWrongError)
  assertProcessedPreviewAligned(await captureToolLayout(cdp, sessionId), 'edited')
  const comparisonHoldRegression = await runComparisonHoldRegression({ cdp, sessionId })

  diagnostics.assertClean()
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDirectory,
  })
  const exportPreviewUrlBeforeGuide = await evaluate(cdp, sessionId, "document.querySelector('.processed-preview')?.src ?? ''")
  await setControlValue(cdp, sessionId, '#composition-guide', 'golden')
  await waitForDom(cdp, sessionId, `document.querySelector('#composition-guide')?.value === 'golden' && document.querySelector('.processed-preview')?.src === ${JSON.stringify(exportPreviewUrlBeforeGuide)} && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the unchanged preview before guide-visible export')
  await clickButton(cdp, sessionId, 'ダウンロード')
  const downloadedFilename = 'e2e-metadata-fixture-replacement-edited.jpg'
  const downloadedPath = await waitForDownloadedFile(downloadDirectory, downloadedFilename)
  const outputBytes = new Uint8Array(await readFile(downloadedPath))
  const outputDimensions = parseJpegDimensions(outputBytes)
  const outputFamilies = detectMetadataFamilies(outputBytes)
  assert(outputDimensions.width === 16 && outputDimensions.height === 16, `Downloaded JPEG dimensions were ${outputDimensions.width}x${outputDimensions.height}, expected 16x16.`)
  assert(Object.values(outputFamilies).every((value) => value === false), `Injected JPEG metadata remained in output: ${JSON.stringify(outputFamilies)}`)
  const exportPreviewUrlAfterExport = await evaluate(cdp, sessionId, "document.querySelector('.processed-preview')?.src ?? ''")
  await setControlValue(cdp, sessionId, '#composition-guide', 'thirds')
  await waitForDom(cdp, sessionId, `document.querySelector('#composition-guide')?.value === 'thirds' && document.querySelector('.processed-preview')?.src === ${JSON.stringify(exportPreviewUrlAfterExport)}`, 'the default guide after guide-visible export')

  const cropDragRegression = await runCropDragBoundsRegression({
    cdp,
    cropDragFixturePath,
    downloadDirectory,
    sessionId,
  })

  const cropSurfaceSizing = await runCropSurfaceSizingRegression({ cdp, layoutFixtures, sessionId })
  const transparencyComparisonRegression = await runTransparencyComparisonRegression({ cdp, fixturePath: transparencyFixturePath, sessionId })
  diagnostics.assertClean()

  const observedRequests = network.getObservedRequests()
  assertNetworkIsLocal(observedRequests, origin, { allowedPaths, requestLog })
  const targetInfo = await getTargetInfo(cdp, targetId)
  return {
    browserTarget: targetInfo ? { targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url } : undefined,
    aspectAndGuideRegression,
    comparisonHoldRegression,
    tabletSaveLayoutRegression,
    dimensions: outputDimensions,
    downloadedBytes: outputBytes.length,
    downloadedFilename: basename(downloadedPath),
    metadata: {
      output: outputFamilies,
      outputMetadataFree: Object.values(outputFamilies).every((value) => value === false),
      source: sourceFamilies,
      sourceExifOrientation: sourceOrientation,
    },
    network: formatNetworkReport(observedRequests),
    cropSurfaceSizing,
    cropDragRegression,
    transparencyComparisonRegression,
    preview: {
      ...previewState,
      pixelEvidence: {
        final: { actual: finalError, wrongMapping: finalWrongError },
        intermediate: { actual: intermediateError, wrongMapping: intermediateWrongError },
      },
    },
    screenshots,
    serverRequests: [...requestLog],
  }
}

async function main() {
  const basePath = normalizeBasePath(process.env.BASE_PATH)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'image-compressor-web-e2e-'))
  const profileDirectory = join(temporaryRoot, 'chrome-profile')
  const downloadDirectory = join(temporaryRoot, 'downloads')
  const fixturePath = join(temporaryRoot, 'e2e-metadata-fixture.jpg')
  const cropDragFixturePath = join(temporaryRoot, 'e2e-crop-drag.png')
  const transparencyFixturePath = join(temporaryRoot, 'e2e-transparent.png')
  const layoutFixtures = CROP_SURFACE_SIZING_CASES.map((fixture) => ({
    ...fixture,
    path: join(temporaryRoot, fixture.filename),
  }))
  await mkdir(profileDirectory)
  await mkdir(downloadDirectory)

  let staticServer
  let chromeProcess
  let cdp
  let pageTargetId
  let pageSessionId
  let report
  try {
    const allowedPaths = await assertProductionBuild(basePath)
    const fixtureBytes = createMetadataJpegFixture()
    const sourceFamilies = detectMetadataFamilies(fixtureBytes)
    const sourceOrientation = parseExifOrientation(fixtureBytes)
    assert(Object.values(sourceFamilies).every((value) => value === true), `Generated fixture is missing metadata families: ${JSON.stringify(sourceFamilies)}`)
    assert(sourceOrientation === 6, `Generated fixture EXIF orientation was ${sourceOrientation}, expected 6.`)
    await writeFile(fixturePath, fixtureBytes)

    staticServer = await startStaticServer(basePath)
    const fallbackResponse = await fetch(`${staticServer.origin}${basePath}e2e-spa-fallback`, {
      headers: { Accept: 'text/html' },
    })
    const fallbackHtml = await fallbackResponse.text()
    assert(fallbackResponse.status === 200 && fallbackHtml.includes('<div id="root"></div>'), 'The static server did not provide SPA fallback beneath BASE_PATH.')

    const chrome = await launchChrome(profileDirectory)
    chromeProcess = chrome.chrome
    cdp = await new CdpConnection(chrome.webSocketUrl).open()
    await cdp.send('Target.setDiscoverTargets', { discover: true })
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDirectory,
    })
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
    pageTargetId = target.targetId
    const attached = await cdp.send('Target.attachToTarget', { flatten: true, targetId: pageTargetId })
    pageSessionId = attached.sessionId

    report = await runScenario({
      allowedPaths,
      basePath,
      cropDragFixturePath,
      cdp,
      downloadDirectory,
      fixturePath,
      layoutFixtures,
      origin: staticServer.origin,
      pageUrl: staticServer.pageUrl,
      requestLog: staticServer.requestLog,
      sessionId: pageSessionId,
      sourceFamilies,
      sourceOrientation,
      transparencyFixturePath,
      targetId: pageTargetId,
    })
    report.staticContentRegression = await runStaticContentRegression({
      basePath,
      cdp,
      origin: staticServer.origin,
      pageUrl: staticServer.pageUrl,
    })
    console.log(JSON.stringify({ basePath, ...report }, null, 2))
    console.log('Chromium E2E: PASS')
  } finally {
    if (cdp && pageTargetId) {
      try {
        await cdp.send('Target.closeTarget', { targetId: pageTargetId })
      } catch {
        // Chrome may already have exited after a failed test.
      }
    }
    if (cdp) {
      await cdp.close()
    }
    await stopChild(chromeProcess)
    await closeServer(staticServer?.server)
    await rm(temporaryRoot, { force: true, recursive: true })
  }
  return report
}

main().catch((error) => {
  console.error(`Chromium E2E: FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
