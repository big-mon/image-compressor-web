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
const EXPECTED_REASSURANCE = '画像のアップロードなし'
const EXPECTED_PRIVACY_COPY = 'すべての処理はこのブラウザ内で完結します。ピクセルにデコードしてから再エンコードするため、出力画像のメタデータは削除されます。JPEGの回転もロスレス変換ではなく再エンコードです。'
const EXPECTED_FOOTER_COPYRIGHT = '© 2026 image-compressor-web'
const SCREENSHOT_DIRECTORY = process.env.E2E_SCREENSHOT_DIR ? resolve(process.env.E2E_SCREENSHOT_DIR) : undefined
const DESKTOP_VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }
const MOBILE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }

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
    const describeComparisonImage = (media) => {
      const image = media.querySelector('img')
      if (!(image instanceof HTMLImageElement)) return null
      const mediaRect = media.getBoundingClientRect()
      const imageRect = image.getBoundingClientRect()
      return {
        image: {
          ...describeBox(imageRect),
          visible: imageRect.width > 0 && imageRect.height > 0,
        },
        media: describeBox(mediaRect),
        objectFit: getComputedStyle(image).objectFit,
      }
    }
    const dropZone = document.querySelector('.drop-zone')
    const advancedControls = document.querySelector('.advanced-controls')
    return {
      advancedControls: advancedControls ? {
        ...describe('.advanced-controls'),
        open: advancedControls.open,
      } : null,
      afterCard: describe('.after-card'),
      changeImage: describe('.change-image-button'),
      comparisonCardCount: document.querySelectorAll('.comparison-card').length,
      comparisonImages: [...document.querySelectorAll('.comparison-media')].map(describeComparisonImage),
      comparisonInEditor: document.querySelector('.comparison-section')?.closest('.editor-column') !== null,
      comparisonMedia: describe('.comparison-media'),
      comparisonNote: describe('.comparison-note'),
      comparisonSection: describe('.comparison-section'),
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
      h1: describe('h1'),
      h1Count: document.querySelectorAll('h1').length,
      mobileWidth: window.innerWidth,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1,
      outputFormat: describe('#output-format'),
      privacyCardPresent: document.querySelector('.privacy-card') !== null,
      privacyCopy: document.querySelector('.privacy-details-body')?.textContent?.trim() ?? '',
      quality: describe('#quality'),
      reassurance: describe('.tool-reassurance'),
      settings: describe('.settings-column'),
      workspace: describe('.workspace'),
      download: describe('.download-button'),
      privacyDetails: describe('.privacy-details'),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
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

function assertBeginsInViewport(rect, viewport, description) {
  assertVisibleRect(rect, description)
  assert(rect.top >= -1 && rect.top <= viewport.height + 1, `${description} does not begin in the initial viewport: ${JSON.stringify({ rect, viewport })}`)
}

function assertComparisonImagesFit(layout, mode) {
  assert(layout.comparisonImages.length === 2 && layout.comparisonImages.every(Boolean), `Expected two comparison images on ${mode}: ${JSON.stringify(layout.comparisonImages)}`)
  for (const [index, comparisonImage] of layout.comparisonImages.entries()) {
    const description = `${mode} comparison image ${index + 1}`
    assert(comparisonImage.objectFit === 'contain', `${description} does not use object-fit: contain: ${JSON.stringify(comparisonImage)}`)
    assertVisibleRect(comparisonImage.image, description)
    assert(
      comparisonImage.image.left >= comparisonImage.media.left - 1 &&
        comparisonImage.image.right <= comparisonImage.media.right + 1 &&
        comparisonImage.image.top >= comparisonImage.media.top - 1 &&
        comparisonImage.image.bottom <= comparisonImage.media.bottom + 1,
      `${description} is not contained by its comparison media: ${JSON.stringify(comparisonImage)}`,
    )
  }
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
  assertVisibleRect(layout.cropSurface, `${mode} crop surface`)
  assert(layout.cropSurface.height <= (mode === 'mobile' ? 204 : 324), `${mode} crop surface is too tall: ${JSON.stringify(layout.cropSurface)}`)
  assert(layout.comparisonInEditor, `The transformed preview is not adjacent to the editor on ${mode}.`)
  assertVisibleRect(layout.editorActions, `${mode} crop action row`)
  assert(layout.editorActions.top >= layout.cropSurface.bottom - 1 && layout.editorActions.top - layout.cropSurface.bottom < 24, `${mode} crop action row is not immediately after the crop surface: ${JSON.stringify({ cropSurface: layout.cropSurface, editorActions: layout.editorActions })}`)
  assertVisibleRect(layout.comparisonSection, `${mode} comparison section`)
  assert(layout.comparisonSection.top > layout.editorActions.bottom, `${mode} comparison section precedes the crop action row: ${JSON.stringify({ comparisonSection: layout.comparisonSection, editorActions: layout.editorActions })}`)
  assert(layout.comparisonCardCount === 2, `Expected compact before/after cards on ${mode}: ${JSON.stringify(layout)}`)
  assert(layout.comparisonNote?.text === 'プレビュー', `The comparison note still exposes implementation jargon on ${mode}: ${JSON.stringify(layout.comparisonNote)}`)
  assertVisibleRect(layout.comparisonMedia, `${mode} comparison media`)
  assert(layout.comparisonMedia.height <= (mode === 'mobile' ? 124 : 184), `${mode} comparison media is not compact: ${JSON.stringify(layout.comparisonMedia)}`)
  assertComparisonImagesFit(layout, mode)
  assertVisibleRect(layout.afterCard, `${mode} transformed preview card`)
  assert(layout.afterCard.top >= layout.comparisonSection.top, `The transformed preview card is outside the comparison section on ${mode}: ${JSON.stringify({ comparisonSection: layout.comparisonSection, afterCard: layout.afterCard })}`)
  assert(layout.advancedControls && layout.advancedControls.open === false && layout.advancedControls.top > layout.comparisonSection.bottom, `Advanced controls are not deferred below the preview on ${mode}: ${JSON.stringify(layout.advancedControls)}`)
  assert(layout.noHorizontalOverflow, `Loaded ${mode} layout overflows horizontally: ${JSON.stringify(layout)}`)

  if (mode === 'desktop') {
    assert(layout.settings.left >= layout.editor.right - 1, `Desktop output settings are not in a right sidebar: ${JSON.stringify({ editor: layout.editor, settings: layout.settings })}`)
    assertInsideViewport(layout.outputFormat, viewport, 'desktop output format')
    assertInsideViewport(layout.quality, viewport, 'desktop quality')
    assertInsideViewport(layout.download, viewport, 'desktop download')
    assert(layout.outputFormat.fontSize >= 16 && layout.download.fontSize >= 16, `Desktop key output controls are too small: ${JSON.stringify({ outputFormat: layout.outputFormat, download: layout.download })}`)
  } else {
    assert(layout.settings.left <= layout.workspace.left + 1, `Mobile output settings did not align with the image workspace: ${JSON.stringify({ workspace: layout.workspace, settings: layout.settings })}`)
    assert(layout.outputFormat.top > layout.cropSurface.bottom, `Mobile output controls do not follow the image workspace: ${JSON.stringify({ cropSurface: layout.cropSurface, outputFormat: layout.outputFormat })}`)
    assertBeginsInViewport(layout.outputFormat, viewport, 'mobile output format')
    assertBeginsInViewport(layout.quality, viewport, 'mobile quality')
    assertVisibleRect(layout.download, 'mobile download')
    assert(layout.comparisonSection.top > layout.settings.bottom, `Mobile before/after comparison does not follow the output settings: ${JSON.stringify({ comparisonSection: layout.comparisonSection, settings: layout.settings })}`)
    assert(layout.outputFormat.top < layout.advancedControls.top && layout.download.bottom < layout.advancedControls.top, `Mobile essential output/save controls do not precede advanced controls: ${JSON.stringify(layout)}`)
  }
  return layout
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
    const previewImage = document.querySelector('.after-card img')
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

async function runScenario({ allowedPaths, basePath, downloadDirectory, fixturePath, pageUrl, origin, requestLog, cdp, sessionId, targetId, sourceFamilies, sourceOrientation }) {
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
  await waitForDom(cdp, sessionId, `document.querySelector('.comparison-card:first-child figcaption span:last-child')?.textContent?.trim() === '16 × 32 px'`, 'the normalized source dimensions')
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
  await waitForDom(cdp, sessionId, `document.querySelector('.comparison-card:first-child figcaption span:last-child')?.textContent?.trim() === '16 × 32 px'`, 'the native file input source dimensions')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the initial Worker preview after native file selection')
  await dispatchFileDrop(cdp, sessionId, '.change-image-button', fixturePath, 'e2e-metadata-fixture-replacement.jpg')
  await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.alt === 'e2e-metadata-fixture-replacement.jpg の編集対象'`, 'the loaded change-image drop replacement')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the replacement Worker preview')
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport after mobile layout checks')
  await openDetails(cdp, sessionId, '.advanced-controls')

  const initialLayout = await evaluate(cdp, sessionId, `(() => {
    const surface = document.querySelector('.crop-surface')
    const sourceImage = document.querySelector('.stage-image')
    const rect = surface?.getBoundingClientRect()
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    return {
      sourceDimensions: document.querySelector('.comparison-card:first-child figcaption span:last-child')?.textContent?.trim(),
      sourceNaturalHeight: sourceImage?.naturalHeight,
      sourceNaturalWidth: sourceImage?.naturalWidth,
      surfaceHeight: rect?.height,
      surfaceRatio: rect ? rect.width / rect.height : undefined,
      surfaceWidth: rect?.width,
      heightCapPx: 320,
      rootFontSize,
    }
  })()`)
  assert(initialLayout.sourceDimensions === '16 × 32 px', `App source dimensions were not normalized: ${JSON.stringify(initialLayout)}`)
  assert(initialLayout.sourceNaturalWidth === 16 && initialLayout.sourceNaturalHeight === 32, `Source img natural dimensions were not normalized: ${JSON.stringify(initialLayout)}`)
  assert(Math.abs(initialLayout.surfaceRatio - 0.5) <= 0.01, `Portrait crop surface ratio was not preserved: ${JSON.stringify(initialLayout)}`)
  assert(initialLayout.surfaceHeight <= initialLayout.heightCapPx + 1, `Desktop crop surface exceeded the useful height cap: ${JSON.stringify(initialLayout)}`)

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
  await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.style.transform === 'translate(-50%, -50%) scaleX(-1) scaleY(-1) rotate(90deg)' && [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('上下反転'))?.classList.contains('is-selected')`, 'the vertical flip')
  await setControlValue(cdp, sessionId, '#quality', '0.57')
  await waitForDom(cdp, sessionId, `document.querySelector('#quality')?.value === '0.57' && document.querySelector('output[for="quality"]')?.textContent?.trim() === '57%'`, 'the JPEG quality change')
  await setControlValue(cdp, sessionId, '#resize-width', '16')
  await waitForDom(cdp, sessionId, `document.querySelector('#resize-width')?.value === '16' && document.querySelector('#resize-height')?.value === ''`, 'the width-only resize control')

  const previewState = await waitFor(async () => {
    const domState = await evaluate(cdp, sessionId, `(() => ({
      afterDimensions: document.querySelector('.after-card figcaption span:last-child')?.textContent?.trim(),
      hasBlobPreview: document.querySelector('.after-card img')?.src.startsWith('blob:') === true,
      outputSize: document.querySelector('.effective-size strong')?.textContent?.trim(),
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
    if (domState.status === 'プレビュー準備完了' && domState.afterDimensions === '16 × 16 px' && domState.outputSize === '16 × 16 px' && domState.hasBlobPreview && workerTargets.length > 0 && verifiedWorkerAssetRequests.length > 0) {
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

  diagnostics.assertClean()
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDirectory,
  })
  await clickButton(cdp, sessionId, 'ダウンロード')
  const downloadedFilename = 'e2e-metadata-fixture-replacement-edited.jpg'
  const downloadedPath = await waitForDownloadedFile(downloadDirectory, downloadedFilename)
  const outputBytes = new Uint8Array(await readFile(downloadedPath))
  const outputDimensions = parseJpegDimensions(outputBytes)
  const outputFamilies = detectMetadataFamilies(outputBytes)
  assert(outputDimensions.width === 16 && outputDimensions.height === 16, `Downloaded JPEG dimensions were ${outputDimensions.width}x${outputDimensions.height}, expected 16x16.`)
  assert(Object.values(outputFamilies).every((value) => value === false), `Injected JPEG metadata remained in output: ${JSON.stringify(outputFamilies)}`)
  diagnostics.assertClean()

  const observedRequests = network.getObservedRequests()
  assertNetworkIsLocal(observedRequests, origin, { allowedPaths, requestLog })
  const targetInfo = await getTargetInfo(cdp, targetId)
  return {
    browserTarget: targetInfo ? { targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url } : undefined,
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
      cdp,
      downloadDirectory,
      fixturePath,
      origin: staticServer.origin,
      pageUrl: staticServer.pageUrl,
      requestLog: staticServer.requestLog,
      sessionId: pageSessionId,
      sourceFamilies,
      sourceOrientation,
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
