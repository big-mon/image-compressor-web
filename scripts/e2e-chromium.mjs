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
const PR8_ASSERTION_TIMEOUT_MS = 3_000
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

async function installWorkerProcessGate(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    if (window.__e2eWorkerProcessGate) {
      return { installed: true }
    }
    const originalPostMessage = Worker.prototype.postMessage
    if (typeof originalPostMessage !== 'function') {
      throw new Error('Worker.prototype.postMessage is unavailable for the deterministic E2E gate.')
    }
    const gate = {
      armed: false,
      held: false,
      payload: undefined,
      arm() {
        if (this.payload) throw new Error('The E2E Worker process gate is already holding a request.')
        this.armed = true
        this.held = false
      },
      release() {
        const payload = this.payload
        if (!payload) return false
        this.payload = undefined
        this.held = false
        this.armed = false
        if (payload.transfer === undefined) {
          originalPostMessage.call(payload.worker, payload.message)
        } else {
          originalPostMessage.call(payload.worker, payload.message, payload.transfer)
        }
        return true
      },
      injectError(message = 'E2E injected Worker encode failure') {
        const payload = this.payload
        if (!payload) return false
        this.payload = undefined
        this.held = false
        payload.worker.dispatchEvent(new MessageEvent('message', {
          data: {
            message,
            requestId: payload.message.requestId,
            type: 'error',
          },
        }))
        return true
      },
      disarm() {
        this.armed = false
        return this.release()
      },
      snapshot() {
        return {
          armed: this.armed,
          held: this.held,
        }
      },
      remove() {
        this.disarm()
        Worker.prototype.postMessage = originalPostMessage
        delete window.__e2eWorkerProcessGate
      },
    }
    const gatedPostMessage = function(message, transfer) {
      if (message && typeof message === 'object' && message.type === 'process') {
        if (gate.armed && !gate.payload) {
          gate.armed = false
          gate.held = true
          gate.payload = { message, transfer, worker: this }
          return undefined
        }
      }
      return originalPostMessage.call(this, message, transfer)
    }
    Object.defineProperty(Worker.prototype, 'postMessage', {
      configurable: true,
      value: gatedPostMessage,
      writable: true,
    })
    window.__e2eWorkerProcessGate = gate
    return { installed: true }
  })()`)
}

async function installDecodeGate(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    if (window.__e2eDecodeGate) {
      return { installed: true, supported: true }
    }
    const originalCreateImageBitmap = window.createImageBitmap
    if (typeof originalCreateImageBitmap !== 'function') {
      return { installed: false, supported: false }
    }
    const gate = {
      armed: false,
      held: false,
      payload: undefined,
      arm() {
        if (this.payload) throw new Error('The E2E decode gate is already holding a decode.')
        this.armed = true
        this.held = false
      },
      async release() {
        const payload = this.payload
        if (!payload) return false
        this.payload = undefined
        this.held = false
        this.armed = false
        try {
          const bitmap = await Reflect.apply(originalCreateImageBitmap, window, payload.args)
          payload.resolve(bitmap)
        } catch (error) {
          payload.reject(error)
        }
        return true
      },
      disarm() {
        this.armed = false
        return Boolean(this.payload)
      },
      snapshot() {
        return { armed: this.armed, held: this.held }
      },
      remove() {
        window.createImageBitmap = originalCreateImageBitmap
        delete window.__e2eDecodeGate
      },
    }
    window.createImageBitmap = function(...args) {
      if (gate.armed && !gate.payload) {
        gate.armed = false
        gate.held = true
        return new Promise((resolvePromise, rejectPromise) => {
          gate.payload = { args, reject: rejectPromise, resolve: resolvePromise }
        })
      }
      return Reflect.apply(originalCreateImageBitmap, this, args)
    }
    window.__e2eDecodeGate = gate
    return { installed: true, supported: true }
  })()`)
}

async function installPreviewDebounceGate(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    if (window.__e2ePreviewDebounceGate) {
      return { installed: true }
    }
    const originalSetTimeout = window.setTimeout
    const gate = {
      armed: false,
      held: false,
      payload: undefined,
      arm() {
        if (this.payload) throw new Error('The E2E preview debounce gate is already holding a callback.')
        this.armed = true
        this.held = false
      },
      release() {
        const payload = this.payload
        if (!payload) return false
        this.payload = undefined
        this.held = false
        this.armed = false
        originalSetTimeout.call(window, () => payload.callback(...payload.args), 0)
        return true
      },
      disarm() {
        this.armed = false
        return this.release()
      },
      snapshot() {
        return { armed: this.armed, held: this.held }
      },
      remove() {
        this.disarm()
        window.setTimeout = originalSetTimeout
        delete window.__e2ePreviewDebounceGate
      },
    }
    window.setTimeout = function(callback, delay, ...args) {
      if (typeof callback === 'function' && delay === 160 && gate.armed && !gate.payload) {
        gate.armed = false
        gate.held = true
        gate.payload = { args, callback }
        return 0
      }
      return originalSetTimeout.call(this, callback, delay, ...args)
    }
    window.__e2ePreviewDebounceGate = gate
    return { installed: true }
  })()`)
}

async function removeE2EGates(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(async () => {
    const debounceGate = window.__e2ePreviewDebounceGate
    debounceGate?.disarm?.()
    debounceGate?.remove?.()
    const decodeGate = window.__e2eDecodeGate
    if (decodeGate?.held) await decodeGate.release()
    decodeGate?.disarm?.()
    decodeGate?.remove?.()
    const workerGate = window.__e2eWorkerProcessGate
    workerGate?.disarm?.()
    workerGate?.remove?.()
    return true
  })()`)
}

async function readPr8State(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const source = document.querySelector('.stage-image')
    const preview = document.querySelector('.processed-preview')
    const readDimensions = (selector) => document.querySelector(selector)?.textContent?.trim() ?? ''
    return {
      busy: document.querySelector('.status-chip')?.classList.contains('is-busy') ?? false,
      crop: [...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value),
      downloadDisabled: document.querySelector('.download-button')?.disabled ?? true,
      effectiveSize: readDimensions('.effective-size strong'),
      error: document.querySelector('.error-message')?.textContent?.trim() ?? '',
      outputMime: document.querySelector('#output-format')?.value ?? '',
      pending: document.querySelector('.comparison-empty') !== null && document.querySelector('.comparison-empty')?.textContent?.includes('更新中') === true,
      previewNaturalHeight: preview instanceof HTMLImageElement ? preview.naturalHeight : 0,
      previewNaturalWidth: preview instanceof HTMLImageElement ? preview.naturalWidth : 0,
      previewUrl: preview instanceof HTMLImageElement ? preview.src : '',
      renderedSize: readDimensions('.quick-preview-dimensions'),
      sourceDimensions: readDimensions('.metrics-card .metric-line:first-child strong'),
      sourceUrl: source instanceof HTMLImageElement ? source.src : '',
      status: document.querySelector('.status-chip')?.textContent?.trim() ?? '',
      quality: Number(document.querySelector('#quality')?.value),
    }
  })()`)
}

function hasUsablePreview(state) {
  return state.busy === false &&
    state.pending === false &&
    state.previewUrl.startsWith('blob:') &&
    state.downloadDisabled === false &&
    (state.status === 'プレビュー準備完了' || (state.status === 'エラー' && state.error.length > 0))
}

async function readWorkerProcessGate(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => window.__e2eWorkerProcessGate?.snapshot?.() ?? null)()`)
}

async function readDecodeGate(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => window.__e2eDecodeGate?.snapshot?.() ?? null)()`)
}

async function readPreviewDebounceGate(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => window.__e2ePreviewDebounceGate?.snapshot?.() ?? null)()`)
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

async function runPersistentComparisonRedRegression({ cdp, fixturePath, pageUrl, sessionId }) {
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await cdp.send('Page.navigate', { url: pageUrl }, sessionId)
  await waitForDom(cdp, sessionId, `document.readyState === 'complete' && document.querySelector('input[type="file"]') !== null`, 'the preview UX regression page')
  await dispatchFileDrop(cdp, sessionId, '.drop-zone', fixturePath)
  await waitForFileLoad(cdp, sessionId)
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the preview UX regression Worker preview')

  await activateComparisonModeWithMouse(cdp, sessionId, 'original')
  const state = await readComparisonState(cdp, sessionId)
  assert(state.comparisonMode === 'original' && state.resultLayer?.visibility === 'hidden', `Persistent comparison did not remain on the original side after a click: ${JSON.stringify(state)}`)
  assert(state.source?.visible && state.crop?.visible && state.processedInCropCount === 0 && state.pendingMaskCount === 0, `The persistent comparison click covered or removed the crop editor: ${JSON.stringify(state)}`)
  return state
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

async function captureScreenshotSamples(cdp, sessionId, points) {
  const result = await cdp.send('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true,
  }, sessionId)
  return evaluate(cdp, sessionId, `(async () => {
    const image = new Image()
    image.src = ${JSON.stringify(`data:image/png;base64,${result.data}`)}
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not create a screenshot sampling context.')
    context.drawImage(image, 0, 0)
    return ${JSON.stringify(points)}.map(([x, y]) => {
      const pixelX = Math.max(0, Math.min(canvas.width - 1, Math.round(x)))
      const pixelY = Math.max(0, Math.min(canvas.height - 1, Math.round(y)))
      const [red, green, blue, alpha] = context.getImageData(pixelX, pixelY, 1, 1).data
      return { alpha, blue, green, red }
    })
  })()`)
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
      const comparisonViewport = document.querySelector('.comparison-viewport')
      const viewportStyle = comparisonViewport ? getComputedStyle(comparisonViewport) : null
      return {
        image: {
          ...describeBox(imageRect),
          visible: imageRect.width > 0 && imageRect.height > 0 && style.visibility !== 'hidden',
        },
        backgroundColor: viewportStyle?.backgroundColor ?? '',
        backgroundImage: viewportStyle?.backgroundImage ?? '',
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
      editorHeaderPresent: document.querySelector('.crop-editor-heading') !== null,
      h1: describe('h1'),
      h1Count: document.querySelectorAll('h1').length,
      mobileWidth: window.innerWidth,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1,
      cropRectangle: describe('.crop-rectangle'),
      cropGuidance: document.querySelector('.crop-guidance')?.textContent?.trim() ?? '',
      outputFormat: describe('#output-format'),
      privacyCardPresent: document.querySelector('.privacy-card') !== null,
      privacyCopy: document.querySelector('.privacy-details-body')?.textContent?.trim() ?? '',
      quality: describe('#quality'),
      reassurance: describe('.tool-reassurance'),
      comparisonSection: describe('.comparison-section'),
      comparisonViewport: describe('.comparison-viewport'),
      comparisonOriginal: describe('.comparison-original-layer'),
      comparisonResult: describe('.comparison-result-layer'),
      comparisonDivider: describe('.comparison-divider'),
      comparisonVerify: describe('.verify-output-button'),
      comparisonSplit: describe('#comparison-split'),
      comparisonMode: [...document.querySelectorAll('.comparison-mode-button')]
        .find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent?.trim() ?? '',
      previewLabel: describe('.stage-preview-label'),
      previewLabelText: document.querySelector('.stage-preview-label')?.textContent?.trim() ?? '',
      processedPreview: describeProcessedPreview(document.querySelector('.processed-preview')),
      processedPreviewCount: document.querySelectorAll('.processed-preview').length,
      renderedSize: readDimensions('.quick-preview-dimensions'),
      fullOutputSize: readDimensions('.full-output-dimensions'),
      settings: describe('.settings-column'),
      sourceImageCount: document.querySelectorAll('.stage-image').length,
      sourceMetrics: describe('.metrics-card .metric-line:first-child strong'),
      status: document.querySelector('.status-chip')?.textContent?.trim() ?? '',
      stageArea: describe('.stage-area'),
      stageMeta: describe('.crop-stage-meta'),
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
  assert(layout.processedPreviewCount === 1 && preview, `Expected one comparison result image on ${mode}: ${JSON.stringify(layout)}`)
  assertVisibleRect(preview.image, description)
  assert(preview.objectFit === 'fill', `${description} does not fill the aligned comparison frame: ${JSON.stringify(preview)}`)
  assert(preview.minWidth === '0px' && preview.minHeight === '0px', `${description} uses crop-rectangle minimum bounds: ${JSON.stringify(preview)}`)
  assert(preview.naturalWidth === layout.renderedSize?.width && preview.naturalHeight === layout.renderedSize?.height, `${description} natural dimensions do not match the rendered metrics: ${JSON.stringify({ preview, renderedSize: layout.renderedSize })}`)
  assert(layout.comparisonViewport && Math.abs(preview.image.left - layout.comparisonViewport.left) <= 1 && Math.abs(preview.image.right - layout.comparisonViewport.right) <= 1 && Math.abs(preview.image.top - layout.comparisonViewport.top) <= 1 && Math.abs(preview.image.bottom - layout.comparisonViewport.bottom) <= 1, `${description} is not mapped to the comparison frame: ${JSON.stringify({ viewport: layout.comparisonViewport, preview: preview.image })}`)
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
  assert(layout.editorHeaderPresent === true, `The crop editor heading is missing on ${mode}: ${JSON.stringify(layout)}`)
  assert(layout.sourceImageCount === 1, `The original image is not represented by exactly one stage image on ${mode}: ${JSON.stringify(layout)}`)
  assert(layout.cropGuidance === '枠内が残る範囲です。暗い外側は削除されます。', `The crop guidance changed unexpectedly on ${mode}: ${JSON.stringify(layout)}`)
  assertVisibleRect(layout.cropSurface, `${mode} crop surface`)
  assertVisibleRect(layout.stageArea, `${mode} stage area`)
  assert(layout.reassurance?.text === EXPECTED_REASSURANCE, `The loaded ${mode} privacy reassurance changed unexpectedly: ${JSON.stringify(layout.reassurance)}`)
  assertInsideViewport(layout.reassurance, viewport, `no-upload reassurance on loaded ${mode}`)
  assert(layout.privacyDetails?.open === false, `Technical privacy details must remain collapsed on loaded ${mode}: ${JSON.stringify(layout.privacyDetails)}`)
  assert(Math.abs(layout.stageArea.width - layout.editor.width) <= 2, `${mode} stage area does not fill the editor column: ${JSON.stringify({ editor: layout.editor, stageArea: layout.stageArea })}`)
  assert(layout.stageArea.height >= (mode === 'mobile' ? 400 : 500), `${mode} stage area was not enlarged for the full-window editor: ${JSON.stringify({ stageArea: layout.stageArea, viewport })}`)
  assert(layout.cropSurface.height > (mode === 'mobile' ? 204 : 324), `${mode} portrait crop surface did not grow beyond the retired height cap: ${JSON.stringify(layout.cropSurface)}`)
  assertVisibleRect(layout.stageMeta, `${mode} crop stage status row`)
  assertVisibleRect(layout.editorActions, `${mode} crop action row`)
  assertVisibleRect(layout.compositionGuide, `${mode} composition guide control`)
  assert(layout.editorActions.top >= layout.stageMeta.bottom - 1 && layout.editorActions.top - layout.stageMeta.bottom < 24, `${mode} crop action row is not immediately after the stage status row: ${JSON.stringify({ stageArea: layout.stageArea, stageMeta: layout.stageMeta, cropSurface: layout.cropSurface, editorActions: layout.editorActions })}`)
  assertVisibleRect(layout.aspectRatio, `${mode} aspect ratio control`)
  assertVisibleRect(layout.comparisonSection, `${mode} comparison section`)
  assertVisibleRect(layout.comparisonViewport, `${mode} comparison viewport`)
  assertVisibleRect(layout.comparisonSplit, `${mode} comparison split control`)
  assertVisibleRect(layout.comparisonVerify, `${mode} full-output confirmation control`)
  assert(layout.comparisonMode === '比較', `${mode} comparison mode did not default to a stable split: ${JSON.stringify(layout)}`)
  assert(layout.previewLabelText === '元画像（切り抜き編集）', `${mode} crop-stage original label is not visible: ${JSON.stringify(layout.previewLabel)}`)
  assertProcessedPreviewAligned(layout, mode)
  assert(layout.advancedControls && layout.advancedControls.open === false && layout.advancedControls.top > layout.editorActions.bottom, `Advanced controls are not deferred below the image editor on ${mode}: ${JSON.stringify(layout.advancedControls)}`)
  assert(layout.noHorizontalOverflow, `Loaded ${mode} layout overflows horizontally: ${JSON.stringify(layout)}`)

  if (mode === 'desktop') {
    assertInsideViewport(layout.stageArea, viewport, 'desktop stage area')
    assert(layout.settings.left >= layout.editor.right - 1, `Desktop output settings are not in a right sidebar: ${JSON.stringify({ editor: layout.editor, settings: layout.settings })}`)
    assertInsideViewport(layout.outputFormat, viewport, 'desktop output format')
    assertVisibleRect(layout.quality, 'desktop save-quality control')
    assert(layout.quality.top >= layout.comparisonSection.top - 1, `Desktop save-quality control is not kept with the comparison section: ${JSON.stringify({ comparisonSection: layout.comparisonSection, quality: layout.quality })}`)
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
    if (!details.open) summary.click()
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

async function runProcessorStartupFailureRegression({ allowedPaths, cdp, fixturePath, origin, pageUrl, requestLog }) {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const targetId = target.targetId
  let sessionId
  let scriptIdentifier
  try {
    const attached = await cdp.send('Target.attachToTarget', { flatten: true, targetId })
    sessionId = attached.sessionId
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Log.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    const diagnostics = new BrowserDiagnostics(cdp, sessionId)
    const network = new NetworkRecorder(cdp, sessionId)
    const script = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.Worker = class ForcedWorkerStartupFailure {
          constructor() {
            throw new Error('E2E forced Worker startup failure')
          }
        }
      })()`,
    }, sessionId)
    scriptIdentifier = script.identifier

    await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId)
    await waitForDom(cdp, sessionId, `document.readyState === 'complete' && document.querySelector('input[type="file"]') !== null`, 'the isolated Worker startup-failure page to load')
    await setFileInput(cdp, sessionId, fixturePath)
    await waitForFileLoad(cdp, sessionId)
    const state = await waitFor(async () => {
      const next = await evaluate(cdp, sessionId, `(() => ({
        assetPresent: document.querySelector('.stage-image') !== null,
        busy: document.querySelector('.status-chip')?.classList.contains('is-busy') ?? false,
        downloadDisabled: document.querySelector('.download-button')?.disabled ?? false,
        error: document.querySelector('.error-message')?.textContent?.trim() ?? '',
        pending: document.querySelector('.processed-preview-pending') !== null,
        status: document.querySelector('.status-chip')?.textContent?.trim() ?? '',
      }))()`)
      if (
        next.assetPresent &&
        next.error.includes('E2E forced Worker startup failure') &&
        next.status === 'エラー' &&
        next.busy === false &&
        next.pending === false &&
        next.downloadDisabled === true
      ) {
        return next
      }
      throw new Error(`Worker startup-failure UI has not settled: ${JSON.stringify(next)}`)
    }, 'the actionable Worker startup error without an endless pending state')
    await delay(200)
    const settled = await evaluate(cdp, sessionId, `(() => ({
      busy: document.querySelector('.status-chip')?.classList.contains('is-busy') ?? false,
      downloadDisabled: document.querySelector('.download-button')?.disabled ?? false,
      error: document.querySelector('.error-message')?.textContent?.trim() ?? '',
      pending: document.querySelector('.processed-preview-pending') !== null,
      status: document.querySelector('.status-chip')?.textContent?.trim() ?? '',
    }))()`)
    assert(settled.error.includes('E2E forced Worker startup failure') && settled.status === 'エラー' && settled.busy === false && settled.pending === false && settled.downloadDisabled === true, `Worker startup failure regressed into a pending or enabled state: ${JSON.stringify(settled)}`)
    diagnostics.assertClean()
    assertNetworkIsLocal(network.getObservedRequests(), origin, { allowedPaths, requestLog })
    return { initial: state, settled }
  } finally {
    if (sessionId && scriptIdentifier) {
      try {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptIdentifier }, sessionId)
      } catch {
        // The isolated target may already be gone after a failed regression.
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

async function restoreReadySource(cdp, sessionId, filePath, description, expectedSourceDimensions) {
  const before = await readPr8State(cdp, sessionId)
  await setFileInput(cdp, sessionId, filePath)
  await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.src !== ${JSON.stringify(before.sourceUrl)}`, `${description} committed source`)
  const ready = await waitFor(async () => {
    const state = await readPr8State(cdp, sessionId)
    if (
      state.status === 'プレビュー準備完了' &&
      state.busy === false &&
      state.pending === false &&
      state.previewUrl.startsWith('blob:') &&
      state.sourceUrl.length > 0 &&
      (!expectedSourceDimensions || state.sourceDimensions === expectedSourceDimensions)
    ) {
      return state
    }
    throw new Error(`Source is not ready after restoration: ${JSON.stringify(state)}`)
  }, `${description} committed Worker preview`, PR8_ASSERTION_TIMEOUT_MS)
  return { before, ready }
}

async function runLoggedPr8Case(label, operation) {
  try {
    const evidence = await operation()
    if (evidence?.skipped) {
      console.log(`[PR8][SKIP] ${label}: ${evidence.reason}`)
      return { evidence, label, status: 'skip' }
    }
    console.log(`[PR8][GREEN] ${label}`)
    return { evidence, label, status: 'green' }
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(`[PR8][RED] ${label}: ${message}`)
    return { error: message, label, status: 'red' }
  }
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
      rendered: readDimensions('.quick-preview-dimensions'),
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

async function resizeCropFromBottomRightWithMouse(cdp, sessionId, delta) {
  const points = await evaluate(cdp, sessionId, `(() => {
    const handle = document.querySelector('.crop-handle')
    if (!(handle instanceof HTMLElement)) throw new Error('Crop resize handle is missing.')
    const rect = handle.getBoundingClientRect()
    const start = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
    const end = { x: start.x + ${Number(delta.x)}, y: start.y + ${Number(delta.y)} }
    return {
      end,
      midpoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
      start,
      startTarget: document.elementFromPoint(start.x, start.y)?.className ?? '',
    }
  })()`)
  assert(String(points.startTarget).split(' ').includes('crop-handle'), `The resize drag did not start on the crop handle: ${JSON.stringify(points)}`)

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
  await delay(50)
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

  await setControlValue(cdp, sessionId, cropInputSelectors[0], 200)
  await setControlValue(cdp, sessionId, cropInputSelectors[1], 100)
  await setControlValue(cdp, sessionId, cropInputSelectors[2], 300)
  await setControlValue(cdp, sessionId, cropInputSelectors[3], 200)
  await setControlValue(cdp, sessionId, cropInputSelectors[2], 30)
  await setControlValue(cdp, sessionId, cropInputSelectors[3], 20)
  await dragCropRectangle(cdp, sessionId, 'right-bottom')
  await waitForDom(cdp, sessionId, `[...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value).join(',') === '970,580,30,20'`, 'the tiny crop moved without resizing')
  for (const viewport of [MOBILE_VIEWPORT, DESKTOP_VIEWPORT]) {
    await setViewport(cdp, sessionId, viewport)
    await setControlValue(cdp, sessionId, cropInputSelectors[2], 1)
    await setControlValue(cdp, sessionId, cropInputSelectors[3], 1)
    await setControlValue(cdp, sessionId, cropInputSelectors[0], 999)
    await setControlValue(cdp, sessionId, cropInputSelectors[1], 599)
    await evaluate(cdp, sessionId, "document.querySelector('.crop-handle').scrollIntoView({ block: 'center' })")
    const target = await evaluate(cdp, sessionId, `(() => {
      const handle = document.querySelector('.crop-handle')
      const rect = handle.getBoundingClientRect()
      const crop = document.querySelector('.crop-rectangle').getBoundingClientRect()
      const stage = document.querySelector('.stage-area').getBoundingClientRect()
      return {
        width: rect.width, height: rect.height,
        outsideCrop: rect.left >= crop.right - 1 && rect.top >= crop.bottom - 1,
        insideStage: rect.right <= stage.right + 1 && rect.bottom <= stage.bottom + 1,
        clickable: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === handle,
      }
    })()`)
    assert(target.width >= 44 && target.height >= 44 && target.outsideCrop && target.insideStage && target.clickable, `The 1px edge crop lost its full-size resize target: ${JSON.stringify({ viewport, target })}`)
    await setControlValue(cdp, sessionId, cropInputSelectors[0], 200)
    await setControlValue(cdp, sessionId, cropInputSelectors[1], 100)
    await resizeCropFromBottomRightWithMouse(cdp, sessionId, { x: 20, y: 20 })
    const resized = await evaluate(cdp, sessionId, "[...document.querySelectorAll('.crop-coordinates input')].map((input) => Number(input.value))")
    assert(resized[0] === 200 && resized[1] === 100 && resized[2] > 1 && resized[3] > 1, `The 1px crop could not be resized: ${JSON.stringify(resized)}`)
  }

  await setControlValue(cdp, sessionId, cropInputSelectors[0], 200)
  await setControlValue(cdp, sessionId, cropInputSelectors[1], 100)
  await setControlValue(cdp, sessionId, cropInputSelectors[2], 300)
  await setControlValue(cdp, sessionId, cropInputSelectors[3], 200)
  const anchoredInitial = await waitFor(async () => {
    const crop = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('.crop-coordinates input')].map((input) => Number(input.value)))()`)
    if (JSON.stringify(crop) === JSON.stringify([200, 100, 300, 200])) return crop
    throw new Error(`The anchored resize starting crop was not adopted: ${JSON.stringify(crop)}`)
  }, 'the anchored resize starting crop')
  await resizeCropFromBottomRightWithMouse(cdp, sessionId, { x: 80, y: 60 })
  const anchoredExpanded = await waitFor(async () => {
    const crop = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('.crop-coordinates input')].map((input) => Number(input.value)))()`)
    if (crop[0] === 200 && crop[1] === 100 && crop[2] > anchoredInitial[2] && crop[3] > anchoredInitial[3]) return crop
    throw new Error(`The real mouse resize did not preserve the top-left anchor while expanding: ${JSON.stringify(crop)}`)
  }, 'the anchored resize expansion')
  await resizeCropFromBottomRightWithMouse(cdp, sessionId, { x: -40, y: -30 })
  const anchoredShrunk = await waitFor(async () => {
    const crop = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('.crop-coordinates input')].map((input) => Number(input.value)))()`)
    if (crop[0] === 200 && crop[1] === 100 && crop[2] < anchoredExpanded[2] && crop[3] < anchoredExpanded[3] && crop[2] > 0 && crop[3] > 0) return crop
    throw new Error(`The real mouse resize did not preserve the top-left anchor while shrinking: ${JSON.stringify(crop)}`)
  }, 'the anchored resize contraction')
  await setControlValue(cdp, sessionId, cropInputSelectors[0], 0)
  await setControlValue(cdp, sessionId, cropInputSelectors[1], 0)
  await setControlValue(cdp, sessionId, cropInputSelectors[2], 400)
  await setControlValue(cdp, sessionId, cropInputSelectors[3], 300)
  await waitForDom(cdp, sessionId, `[
    ...document.querySelectorAll('.crop-coordinates input'),
  ].map((input) => input.value).join(',') === '0,0,400,300'`, 'the crop restored after anchored resize')

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
    anchoredResize: {
      expanded: anchoredExpanded,
      initial: anchoredInitial,
      shrunk: anchoredShrunk,
    },
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

async function readComparisonState(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const describe = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        visibility: style.visibility,
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      }
    }
    const result = document.querySelector('.comparison-result-image')
    const selected = [...document.querySelectorAll('.comparison-mode-button')]
      .find((button) => button.getAttribute('aria-pressed') === 'true')
    const viewport = document.querySelector('.comparison-viewport')
    const canvas = document.querySelector('.comparison-canvas')
    return {
      canvas: describe('.comparison-canvas'),
      comparisonMode: selected?.getAttribute('data-comparison-mode') ?? '',
      comparisonModeLabel: selected?.textContent?.trim() ?? '',
      crop: describe('.crop-rectangle'),
      divider: describe('.comparison-divider'),
      dividerStyle: document.querySelector('.comparison-divider') ? getComputedStyle(document.querySelector('.comparison-divider')).left : '',
      fullButton: {
        disabled: document.querySelector('.verify-output-button')?.hasAttribute('disabled') ?? true,
        text: document.querySelector('.verify-output-button')?.textContent?.trim() ?? '',
      },
      originalClipPath: document.querySelector('.comparison-original-layer')
        ? getComputedStyle(document.querySelector('.comparison-original-layer')).clipPath
        : '',
      originalLayer: describe('.comparison-original-layer'),
      pendingMaskCount: document.querySelectorAll('.stage-area .processed-preview-pending').length,
      processedInCropCount: document.querySelectorAll('.stage-area .processed-preview').length,
      resultImage: result ? {
        ...describe('.comparison-result-image'),
        dataKind: result.getAttribute('data-preview-kind') ?? '',
        naturalHeight: result instanceof HTMLImageElement ? result.naturalHeight : 0,
        naturalWidth: result instanceof HTMLImageElement ? result.naturalWidth : 0,
        outputBytes: Number(result.getAttribute('data-output-bytes')),
      } : null,
      resultLayer: describe('.comparison-result-layer'),
      split: Number(document.querySelector('#comparison-split')?.value),
      viewport: describe('.comparison-viewport'),
      viewportBackground: viewport ? {
        color: getComputedStyle(viewport).backgroundColor,
        image: getComputedStyle(viewport).backgroundImage,
      } : null,
      viewportScroll: viewport ? {
        clientHeight: viewport.clientHeight,
        clientWidth: viewport.clientWidth,
        scrollHeight: viewport.scrollHeight,
        scrollWidth: viewport.scrollWidth,
      } : null,
      qualityHelp: document.querySelector('#quality-help')?.textContent?.trim() ?? '',
      qualityLabel: document.querySelector('label[for="quality"]')?.textContent?.trim() ?? '',
      qualityRect: describe('#quality'),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1,
      source: describe('.stage-image'),
      sourceVisibility: document.querySelector('.stage-image') ? getComputedStyle(document.querySelector('.stage-image')).visibility : '',
      viewportIsActual: document.querySelector('.comparison-viewport')?.classList.contains('is-actual') ?? false,
      inspectionActualDisabled: document.querySelector('.comparison-inspection-button[aria-pressed="true"]')?.textContent?.trim() === '100%表示'
        ? document.querySelector('.comparison-inspection-button[aria-pressed="true"]')?.hasAttribute('disabled') ?? true
        : document.querySelector('.comparison-inspection-button')?.parentElement?.querySelector('button:last-of-type')?.hasAttribute('disabled') ?? true,
      inspectionMode: [...document.querySelectorAll('.comparison-inspection-button')]
        .find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent?.trim() ?? '',
      viewportElement: Boolean(canvas),
    }
  })()`)
}

function assertComparisonRectsAligned(state, description) {
  const target = state.canvas ?? state.viewport
  assert(target && state.originalLayer && state.resultImage, `${description} is missing comparison geometry: ${JSON.stringify(state)}`)
  const aligned = (rect) => Math.abs(rect.left - target.left) <= 1 &&
    Math.abs(rect.right - target.right) <= 1 &&
    Math.abs(rect.top - target.top) <= 1 &&
    Math.abs(rect.bottom - target.bottom) <= 1
  assert(aligned(state.originalLayer), `${description} original layer is not aligned: ${JSON.stringify({ target, original: state.originalLayer })}`)
  assert(aligned(state.resultImage), `${description} result image is not aligned: ${JSON.stringify({ target, result: state.resultImage })}`)
}

async function activateComparisonModeWithMouse(cdp, sessionId, mode) {
  const point = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector(${JSON.stringify(`[data-comparison-mode="${mode}"]`)})
    if (!(button instanceof HTMLElement)) throw new Error('Comparison mode button is missing: ' + ${JSON.stringify(mode)})
    button.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = button.getBoundingClientRect()
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  }, sessionId)
}

async function dispatchComparisonKey(cdp, sessionId, mode, key) {
  const focusState = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector(${JSON.stringify(`[data-comparison-mode="${mode}"]`)})
    if (!(button instanceof HTMLElement)) throw new Error('Comparison mode button is missing for keyboard input: ' + ${JSON.stringify(mode)})
    button.focus()
    return {
      active: document.activeElement === button,
      mode: button.getAttribute('data-comparison-mode') ?? '',
    }
  })()`)
  assert(focusState.active === true && focusState.mode === mode, `Comparison mode button did not receive keyboard focus: ${JSON.stringify(focusState)}`)
  const code = key === ' ' ? 'Space' : 'Enter'
  const keyCode = key === ' ' ? 32 : 13
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    text: key === ' ' ? ' ' : '\r',
    unmodifiedText: key === ' ' ? ' ' : '\r',
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  }, sessionId)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  }, sessionId)
}

async function runComparisonPersistenceRegression({ cdp, sessionId }) {
  await clickButton(cdp, sessionId, '編集をリセット')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the comparison regression reset preview')
  await setControlValue(cdp, sessionId, '#aspect-ratio', '1:1')
  await clickButton(cdp, sessionId, '右へ90°')
  await clickButton(cdp, sessionId, '左右反転')
  await clickButton(cdp, sessionId, '上下反転')
  await setControlValue(cdp, sessionId, '#resize-width', '12')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了' && document.querySelector('.comparison-result-image')?.getAttribute('data-preview-kind') === 'quick'`, 'the aligned transformed comparison preview')

  await activateComparisonModeWithMouse(cdp, sessionId, 'original')
  await waitForDom(cdp, sessionId, `document.querySelector('[data-comparison-mode="original"]')?.getAttribute('aria-pressed') === 'true'`, 'a persistent mouse comparison click')
  const mouseState = await readComparisonState(cdp, sessionId)
  assert(mouseState.comparisonMode === 'original' && mouseState.resultImage?.visibility === 'hidden', `Mouse comparison click did not persist: ${JSON.stringify(mouseState)}`)
  await evaluate(cdp, sessionId, 'window.dispatchEvent(new Event("blur"))')
  const blurState = await readComparisonState(cdp, sessionId)
  assert(blurState.comparisonMode === 'original', `Window blur changed the selected comparison mode: ${JSON.stringify(blurState)}`)

  await activateComparisonModeWithMouse(cdp, sessionId, 'compare')
  await dispatchComparisonKey(cdp, sessionId, 'original', 'Enter')
  await waitForDom(cdp, sessionId, `document.querySelector('[data-comparison-mode="original"]')?.getAttribute('aria-pressed') === 'true'`, 'keyboard Enter comparison selection')
  await dispatchComparisonKey(cdp, sessionId, 'compare', ' ')
  await waitForDom(cdp, sessionId, `document.querySelector('[data-comparison-mode="compare"]')?.getAttribute('aria-pressed') === 'true'`, 'keyboard Space comparison selection')

  await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${MOBILE_VIEWPORT.width} && window.innerHeight === ${MOBILE_VIEWPORT.height}`, 'the mobile comparison controls viewport')
  await evaluate(cdp, sessionId, `document.querySelector('.comparison-section')?.scrollIntoView({ block: 'center', inline: 'nearest' })`)
  const touchPoint = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('[data-comparison-mode="result"]')
    if (!(button instanceof HTMLElement)) throw new Error('Comparison result button is missing for touch input.')
    const rect = button.getBoundingClientRect()
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
  })()`)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x: touchPoint.x, y: touchPoint.y, radiusX: 4, radiusY: 4, force: 1 }],
  }, sessionId)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId)
  await waitForDom(cdp, sessionId, `document.querySelector('[data-comparison-mode="result"]')?.getAttribute('aria-pressed') === 'true'`, 'touch comparison selection')
  const mobileState = await readComparisonState(cdp, sessionId)
  assert(mobileState.noHorizontalOverflow, `Mobile comparison controls overflow horizontally: ${JSON.stringify(mobileState)}`)
  assert(mobileState.qualityRect?.height >= 44 && mobileState.qualityRect?.width > 0, `Mobile save-quality control is not usable beside comparison: ${JSON.stringify(mobileState)}`)

  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop comparison controls viewport')
  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0)')
  await activateComparisonModeWithMouse(cdp, sessionId, 'compare')

  const gate = await installWorkerProcessGate(cdp, sessionId)
  assert(gate?.installed, 'Could not install the comparison pending Worker gate.')
  let pendingState
  try {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await setControlValue(cdp, sessionId, '#quality', '0.56')
    await waitFor(async () => {
      const held = await readWorkerProcessGate(cdp, sessionId)
      if (held?.held) return held
      throw new Error(`Comparison pending Worker gate is not holding: ${JSON.stringify(held)}`)
    }, 'the comparison pending Worker request')
    pendingState = await readComparisonState(cdp, sessionId)
    assert(pendingState.source?.visible && pendingState.crop?.visible, `Crop editor disappeared during preview regeneration: ${JSON.stringify(pendingState)}`)
    assert(pendingState.processedInCropCount === 0 && pendingState.pendingMaskCount === 0, `Encoded output or an opaque pending mask covered crop editing: ${JSON.stringify(pendingState)}`)
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.remove()').catch(() => {})
  }
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了' && document.querySelector('.comparison-result-image')?.getAttribute('data-preview-kind') === 'quick'`, 'the comparison preview after pending regeneration')
  const pendingCompleted = await readComparisonState(cdp, sessionId)
  assert(pendingCompleted.comparisonMode === 'compare', `Preview regeneration changed the selected comparison mode: ${JSON.stringify(pendingCompleted)}`)

  const splitResults = {}
  for (const split of [0, 100, 50]) {
    await setControlValue(cdp, sessionId, '#comparison-split', split)
    const state = await waitFor(async () => {
      const next = await readComparisonState(cdp, sessionId)
      if (next.split === split && next.comparisonMode === 'compare') return next
      throw new Error(`Comparison split has not reached ${split}: ${JSON.stringify(next)}`)
    }, `comparison split ${split}%`)
    assertComparisonRectsAligned(state, `comparison split ${split}%`)
    if (split === 0) {
      assert(state.originalClipPath.includes('100%'), `The 0% split did not hide the original side: ${JSON.stringify(state)}`)
      assert(Math.abs(state.divider.left - state.viewport.left) <= 1, `The 0% divider is not at the left endpoint: ${JSON.stringify(state)}`)
    }
    if (split === 100) {
      assert(state.originalClipPath.includes('0%'), `The 100% split did not show the original side: ${JSON.stringify(state)}`)
      assert(Math.abs(state.divider.right - state.viewport.right) <= 1, `The 100% divider is not at the right endpoint: ${JSON.stringify(state)}`)
    }
    splitResults[split] = state
  }

  await evaluate(cdp, sessionId, `document.querySelector('.comparison-section')?.scrollIntoView({ block: 'center', inline: 'nearest' })`)
  const desktopScreenshot = await captureScreenshot(cdp, sessionId, 'comparison-desktop.png')
  await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${MOBILE_VIEWPORT.width} && window.innerHeight === ${MOBILE_VIEWPORT.height}`, 'the mobile comparison screenshot viewport')
  await evaluate(cdp, sessionId, `document.querySelector('.comparison-section')?.scrollIntoView({ block: 'center', inline: 'nearest' })`)
  const mobileScreenshot = await captureScreenshot(cdp, sessionId, 'comparison-mobile.png')
  const screenshotState = await readComparisonState(cdp, sessionId)
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport after comparison screenshots')
  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0)')

  await clickButton(cdp, sessionId, '編集をリセット')
  await waitForDom(cdp, sessionId, `document.querySelector('#aspect-ratio')?.value === 'original' && [...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value).join(',') === '0,0,16,32' && document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the comparison regression cleanup preview')

  return {
    blurState,
    desktopScreenshot,
    mobileScreenshot,
    mobileState,
    mouseState,
    pendingState,
    pendingCompleted,
    screenshotState,
    splitResults,
  }
}

async function assertFitComparison(cdp, sessionId, ratio) {
  const size = await evaluate(cdp, sessionId, `(() => {
    const viewport = document.querySelector('.comparison-viewport')
    const canvas = document.querySelector('.comparison-canvas').getBoundingClientRect()
    return { width: viewport.clientWidth, height: viewport.clientHeight, canvasWidth: canvas.width, canvasHeight: canvas.height }
  })()`)
  assert(size.width > 0 && size.height > 0 && Math.abs(size.width / size.height - ratio) < 0.02, `Fit comparison lost its crop ratio: ${JSON.stringify({ size, ratio })}`)
  assert(Math.abs(size.canvasWidth - size.width) < 2 && Math.abs(size.canvasHeight - size.height) < 2, `Fit comparison clips its canvas: ${JSON.stringify(size)}`)
}

async function runFullOutputComparisonRegression({ cdp, cropDragFixturePath, downloadDirectory, fixturePath, sessionId }) {
  await restoreReadySource(cdp, sessionId, cropDragFixturePath, 'full-size comparison source', '1000 × 600 px')
  await clickButton(cdp, sessionId, '比較')
  const quick = await waitFor(async () => {
    const state = await readComparisonState(cdp, sessionId)
    if (state.resultImage?.dataKind === 'quick' && state.resultImage.naturalWidth === 960 && state.resultImage.naturalHeight === 576) {
      return state
    }
    throw new Error(`The reduced comparison preview is not ready: ${JSON.stringify(state)}`)
  }, 'the reduced 960px comparison preview')
  assert(quick.resultImage.naturalWidth <= 960 && quick.resultImage.naturalHeight < 600, `The quick comparison preview was not reduced: ${JSON.stringify(quick)}`)
  assert(await evaluate(cdp, sessionId, "document.querySelector('.quick-preview-dimensions')?.textContent?.trim()") === '960 × 576 px', `Quick preview metrics do not describe the reduced image: ${JSON.stringify(quick)}`)
  assert(await evaluate(cdp, sessionId, "document.querySelector('.full-output-dimensions')?.textContent?.trim()") === '未確認', 'Full output was claimed before explicit confirmation.')
  assertComparisonRectsAligned(quick, 'quick comparison alignment')

  const workerGate = await installWorkerProcessGate(cdp, sessionId)
  const debounceGate = await installPreviewDebounceGate(cdp, sessionId)
  assert(workerGate?.installed && debounceGate?.installed, 'Could not install the full-output busy/error gates.')
  let full
  let fullBusyErrorRegression
  let desktopScreenshot
  let mobileScreenshot
  try {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await clickButton(cdp, sessionId, '保存サイズを確認')
    const heldFull = await waitFor(async () => {
      const state = await readComparisonState(cdp, sessionId)
      const fullDimensions = await evaluate(cdp, sessionId, "document.querySelector('.full-output-dimensions')?.textContent?.trim()")
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.fullButton.disabled && state.fullButton.text.includes('確認中') && fullDimensions === '未確認') {
        return { fullDimensions, gate, state }
      }
      throw new Error(`The full-size confirmation was not held with its button disabled: ${JSON.stringify({ fullDimensions, gate, state })}`)
    }, 'the held full-size confirmation', PR8_ASSERTION_TIMEOUT_MS)
    assert(await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.injectError("E2E full-size confirmation failure")') === true, 'The held full-size confirmation did not accept the injected error.')
    const failedFull = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const comparison = await readComparisonState(cdp, sessionId)
      const fullDimensions = await evaluate(cdp, sessionId, "document.querySelector('.full-output-dimensions')?.textContent?.trim()")
      if (state.error === 'E2E full-size confirmation failure' && state.status === 'エラー' && state.busy === false && state.pending === false && comparison.fullButton.disabled === false && comparison.resultImage?.dataKind === 'quick' && fullDimensions === '未確認') {
        return { comparison, fullDimensions, state }
      }
      throw new Error(`The failed full-size confirmation did not retain the quick result: ${JSON.stringify({ comparison, fullDimensions, state })}`)
    }, 'the failed full-size confirmation fallback', PR8_ASSERTION_TIMEOUT_MS)

    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await clickButton(cdp, sessionId, '保存サイズを確認')
    const retryHeld = await waitFor(async () => {
      const state = await readComparisonState(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.fullButton.disabled && state.fullButton.text.includes('確認中')) return { gate, state }
      throw new Error(`The full-size confirmation retry was not held as busy: ${JSON.stringify({ gate, state })}`)
    }, 'the retry full-size confirmation', PR8_ASSERTION_TIMEOUT_MS)
    await evaluate(cdp, sessionId, `window.__e2eWorkerProcessGate.payload.worker.addEventListener('message', (event) => {
      window.__e2eConfirmedBytes = event.data.blob.arrayBuffer().then((buffer) => Array.from(new Uint8Array(buffer)))
    }, { once: true })`)
    assert(await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.release()') === true, 'The full-size confirmation retry was not released.')
    full = await waitFor(async () => {
      const state = await readComparisonState(cdp, sessionId)
      const fullDimensions = await evaluate(cdp, sessionId, "document.querySelector('.full-output-dimensions')?.textContent?.trim()")
      if (state.resultImage?.dataKind === 'full' && state.resultImage.naturalWidth === 1000 && state.resultImage.naturalHeight === 600 && fullDimensions === '1000 × 600 px') {
        return { ...state, fullDimensions }
      }
      throw new Error(`The full-size comparison result is not ready after retry: ${JSON.stringify({ state, fullDimensions })}`)
    }, 'the full-size encoded comparison result after retry', PR8_ASSERTION_TIMEOUT_MS)

    assert(full.resultImage.naturalWidth > 960, `The full comparison still uses a reduced image: ${JSON.stringify(full)}`)
    assert(full.resultImage.outputBytes > 0, `The full comparison has no encoded byte metric: ${JSON.stringify(full)}`)
    assert(await evaluate(cdp, sessionId, "document.querySelector('.quick-preview-dimensions')?.textContent?.trim()") === '960 × 576 px', `Quick preview metrics were overwritten by full output metrics: ${JSON.stringify(full)}`)
    assert(await evaluate(cdp, sessionId, "document.querySelector('.full-output-bytes-value')?.textContent?.trim()") !== '未確認', `Full output byte metrics were not published: ${JSON.stringify(full)}`)
    const reportedFullBytes = await evaluate(cdp, sessionId, "Number(document.querySelector('.comparison-result-image')?.getAttribute('data-output-bytes'))")
    assert(reportedFullBytes === full.resultImage.outputBytes, `Full output byte metrics changed between the Worker result and comparison image: ${JSON.stringify({ full, reportedFullBytes })}`)
    assertComparisonRectsAligned(full, 'full-size comparison alignment')
    await assertFitComparison(cdp, sessionId, 1000 / 600)
    await clickButton(cdp, sessionId, '100%表示')
    const actualInspection = await waitFor(async () => {
      const state = await readComparisonState(cdp, sessionId)
      if (state.inspectionMode === '100%表示' && state.viewportIsActual && state.canvas?.width === 1000 && state.canvas?.height === 600 && state.resultImage?.width === 1000 && state.resultImage?.height === 600 && state.viewportScroll?.scrollWidth >= 1000 && state.viewportScroll?.scrollHeight >= 600) return state
      throw new Error(`The 100% full-size comparison does not expose the real output rectangle: ${JSON.stringify(state)}`)
    }, 'the 100% full-size comparison rectangle', PR8_ASSERTION_TIMEOUT_MS)
    assertComparisonRectsAligned(actualInspection, '100% full-size comparison alignment')
    await clickButton(cdp, sessionId, '全体表示')
    await waitForDom(cdp, sessionId, `document.querySelector('.comparison-inspection-button[aria-pressed="true"]')?.textContent?.trim() === '全体表示'`, 'the fit comparison after 100% inspection')
    await evaluate(cdp, sessionId, `document.querySelector('.comparison-section')?.scrollIntoView({ block: 'center', inline: 'nearest' })`)
    await assertFitComparison(cdp, sessionId, 1000 / 600)
    desktopScreenshot = await captureScreenshot(cdp, sessionId, 'comparison-full-desktop.png')
    await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
    await waitForDom(cdp, sessionId, `window.innerWidth === ${MOBILE_VIEWPORT.width} && window.innerHeight === ${MOBILE_VIEWPORT.height}`, 'the mobile full-size comparison viewport')
    await evaluate(cdp, sessionId, `document.querySelector('.comparison-section')?.scrollIntoView({ block: 'center', inline: 'nearest' })`)
    await assertFitComparison(cdp, sessionId, 1000 / 600)
    mobileScreenshot = await captureScreenshot(cdp, sessionId, 'comparison-full-mobile.png')
    await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
    await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport after full-size comparison')
    await evaluate(cdp, sessionId, 'window.scrollTo(0, 0)')

    const confirmedBytes = await evaluate(cdp, sessionId, 'window.__e2eConfirmedBytes')
    const cachedDownloadPath = join(downloadDirectory, 'e2e-crop-drag-edited.jpg')
    await rm(cachedDownloadPath, { force: true })
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await clickButton(cdp, sessionId, 'ダウンロード')
    assert(!(await readWorkerProcessGate(cdp, sessionId)).held, 'Downloading a confirmed result submitted another Worker request.')
    await waitForDownloadedFile(downloadDirectory, 'e2e-crop-drag-edited.jpg')
    assert((await readFile(cachedDownloadPath)).equals(Buffer.from(confirmedBytes)), 'Downloaded bytes differ from the confirmed full-size image.')
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm(); delete window.__e2eConfirmedBytes')

    const staleQualityBefore = await readPr8State(cdp, sessionId)
    const staleQuality = Math.abs(staleQualityBefore.quality - 0.63) < 0.001 ? 0.74 : 0.63
    await clickButton(cdp, sessionId, '編集をリセット')
    await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the full-output stale completion baseline reset')
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm(); window.__e2ePreviewDebounceGate.arm()')
    await clickButton(cdp, sessionId, '保存サイズを確認')
    const staleHeld = await waitFor(async () => {
      const state = await readComparisonState(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.fullButton.disabled && state.fullButton.text.includes('確認中')) return { gate, state }
      throw new Error(`The stale full-size request was not held: ${JSON.stringify({ gate, state })}`)
    }, 'the stale full-size request', PR8_ASSERTION_TIMEOUT_MS)
    await setControlValue(cdp, sessionId, '#quality', staleQuality)
    const staleBusy = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const comparison = await readComparisonState(cdp, sessionId)
      const debounce = await readPreviewDebounceGate(cdp, sessionId)
      if (debounce?.held && state.quality === staleQuality && state.busy && state.pending && comparison.fullButton.disabled && comparison.resultImage === null) {
        return { comparison, debounce, state }
      }
      throw new Error(`The edited preview did not disable full confirmation during debounce: ${JSON.stringify({ comparison, debounce, state })}`)
    }, 'the disabled full confirmation during stale preview debounce', PR8_ASSERTION_TIMEOUT_MS)
    assert(await evaluate(cdp, sessionId, 'window.__e2ePreviewDebounceGate.release()') === true, 'The stale preview debounce was not released.')
    const currentQuick = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const comparison = await readComparisonState(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      const fullDimensions = await evaluate(cdp, sessionId, "document.querySelector('.full-output-dimensions')?.textContent?.trim()")
      if (gate?.held && state.quality === staleQuality && state.status === 'プレビュー準備完了' && state.busy === false && state.pending === false && comparison.resultImage?.dataKind === 'quick' && fullDimensions === '未確認') {
        return { comparison, fullDimensions, state }
      }
      throw new Error(`The edited quick preview did not settle while the old full request remained held: ${JSON.stringify({ comparison, fullDimensions, gate, state })}`)
    }, 'the current quick preview before stale full completion', PR8_ASSERTION_TIMEOUT_MS)
    assert(await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.release()') === true, 'The stale full-size request was not released.')
    const staleFull = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const comparison = await readComparisonState(cdp, sessionId)
      const fullDimensions = await evaluate(cdp, sessionId, "document.querySelector('.full-output-dimensions')?.textContent?.trim()")
      if (state.quality === staleQuality && comparison.resultImage?.dataKind === 'quick' && fullDimensions === '未確認' && state.status === 'プレビュー準備完了' && state.busy === false) {
        return { comparison, fullDimensions, state }
      }
      throw new Error(`A stale full-size completion replaced the edited quick result: ${JSON.stringify({ comparison, fullDimensions, state })}`)
    }, 'the ignored stale full-size completion', PR8_ASSERTION_TIMEOUT_MS)
    fullBusyErrorRegression = { actualInspection, failedFull, heldFull, retryHeld, staleBusy, staleFull, staleHeld, currentQuick }

    const beforeRestore = await readPr8State(cdp, sessionId)
    await dispatchFileDrop(cdp, sessionId, '.change-image-button', fixturePath, 'e2e-metadata-fixture-replacement.jpg')
    await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.src !== ${JSON.stringify(beforeRestore.sourceUrl)}`, 'the named source after full-size comparison')
    await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了' && document.querySelector('.quick-preview-dimensions')?.textContent?.trim() === '16 × 32 px'`, 'the replacement preview after full-size comparison')
    await assertFitComparison(cdp, sessionId, 0.5)
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2ePreviewDebounceGate.disarm()').catch(() => {})
    await evaluate(cdp, sessionId, 'window.__e2ePreviewDebounceGate.remove()').catch(() => {})
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.remove()').catch(() => {})
  }

  return {
    desktopScreenshot,
    full,
    fullBusyErrorRegression,
    mobileScreenshot,
    quick,
  }
}

async function runCorruptReplacementRegression({ cdp, corruptFixturePath, downloadDirectory, sessionId, unsupportedFixturePath }) {
  const before = await evaluate(cdp, sessionId, `(() => ({
    crop: [...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value),
    previewUrl: document.querySelector('.processed-preview')?.src ?? '',
    sourceUrl: document.querySelector('.stage-image')?.src ?? '',
  }))()`)
  assert(before.previewUrl.startsWith('blob:') && before.sourceUrl.startsWith('blob:'), `The corrupt replacement regression has no stable source/preview URLs: ${JSON.stringify(before)}`)

  const waitForRetainedPreview = async (filePath, description) => {
    await setFileInput(cdp, sessionId, filePath)
    return waitFor(async () => {
    const state = await evaluate(cdp, sessionId, `(() => ({
      busy: document.querySelector('.status-chip')?.classList.contains('is-busy') ?? false,
      crop: [...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value),
      downloadDisabled: document.querySelector('.download-button')?.disabled ?? true,
      error: document.querySelector('.error-message')?.textContent?.trim() ?? '',
      pending: document.querySelector('.processed-preview-pending') !== null,
      previewUrl: document.querySelector('.processed-preview')?.src ?? '',
      sourceUrl: document.querySelector('.stage-image')?.src ?? '',
      status: document.querySelector('.status-chip')?.textContent?.trim() ?? '',
    }))()`)
    if (
      state.error.length > 0 &&
      (state.status === 'プレビュー準備完了' || state.status === 'エラー') &&
      state.busy === false &&
      state.pending === false &&
      state.downloadDisabled === false &&
      state.previewUrl === before.previewUrl &&
      state.sourceUrl === before.sourceUrl &&
      JSON.stringify(state.crop) === JSON.stringify(before.crop)
    ) {
      return state
    }
      throw new Error(`${description} has not retained the previous usable result: ${JSON.stringify(state)}`)
    }, description, PR8_ASSERTION_TIMEOUT_MS)
  }

  const restored = await waitForRetainedPreview(corruptFixturePath, 'the previous preview after corrupt replacement')
  const unsupportedRestored = await waitForRetainedPreview(unsupportedFixturePath, 'the previous preview after unsupported replacement')

  await clickButton(cdp, sessionId, 'ダウンロード')
  const downloadedFilename = 'e2e-metadata-fixture-edited.jpg'
  const downloadedPath = await waitForDownloadedFile(downloadDirectory, downloadedFilename)
  const downloadedBytes = new Uint8Array(await readFile(downloadedPath))
  assert(downloadedBytes.length > 0, `The download after corrupt replacement was empty: ${downloadedFilename}`)

  return {
    before,
    downloadedBytes: downloadedBytes.length,
    downloadedFilename: basename(downloadedPath),
    restored,
    unsupportedRestored,
  }
}

async function readAccessibleStageImages(cdp, sessionId) {
  try {
    const result = await cdp.send('Accessibility.getFullAXTree', { depth: -1 }, sessionId)
    return {
      images: (result.nodes ?? [])
        .filter((node) => node.ignored !== true && node.role?.value === 'image')
        .map((node) => ({ name: node.name?.value ?? '', nodeId: node.nodeId })),
      supported: true,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      images: [],
      supported: false,
    }
  }
}

async function runAccessibilityOcclusionRegression({ cdp, fixturePath, sessionId }) {
  await restoreReadySource(cdp, sessionId, fixturePath, 'AX ownership baseline', '16 × 32 px')
  await activateComparisonModeWithMouse(cdp, sessionId, 'compare')
  const labels = await evaluate(cdp, sessionId, `(() => ({
    original: document.querySelector('.comparison-original-image')?.getAttribute('alt') ?? '',
    processed: document.querySelector('.comparison-result-image')?.getAttribute('alt') ?? '',
    stage: document.querySelector('.stage-image')?.getAttribute('alt') ?? '',
  }))()`)
  assert(labels.original.length > 0 && labels.processed.length > 0 && labels.stage.length > 0, `Accessibility labels are missing from the comparison images: ${JSON.stringify(labels)}`)

  const readMode = async (mode) => waitFor(async () => {
    const ax = await readAccessibleStageImages(cdp, sessionId)
    if (!ax.supported) {
      return ax
    }
    const names = ax.images.map((image) => image.name)
    const expected = mode === 'compare'
      ? [labels.stage, labels.original, labels.processed]
      : mode === 'original' || mode === 'pending'
        ? [labels.stage, labels.original]
        : [labels.stage, labels.processed]
    const hidden = mode === 'compare'
      ? []
      : mode === 'original' || mode === 'pending'
        ? [labels.processed]
        : [labels.original]
    if (expected.every((label) => names.includes(label)) && hidden.every((label) => !names.includes(label))) {
      return ax
    }
    throw new Error(`AX ${mode} comparison image ownership is not settled: ${JSON.stringify({ ax, expected, hidden })}`)
  }, `the ${mode} AX image ownership`, PR8_ASSERTION_TIMEOUT_MS)

  const compared = await readMode('compare')
  if (!compared.supported) {
    return { compared, reason: `CDP Accessibility.getFullAXTree unavailable: ${compared.error}`, skipped: true }
  }

  try {
    const baseline = await readPr8State(cdp, sessionId)
    const nextQuality = Math.abs(baseline.quality - 0.57) < 0.001 ? 0.71 : 0.57
    assert(baseline.status === 'プレビュー準備完了' && baseline.busy === false && baseline.pending === false && baseline.previewUrl.startsWith('blob:'), `AX ownership baseline is not a completed preview: ${JSON.stringify(baseline)}`)
    assert(await readWorkerProcessGate(cdp, sessionId), 'The Worker process gate was not installed for pending AX ownership.')
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await setControlValue(cdp, sessionId, '#quality', nextQuality)
    const pending = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.busy && state.pending && state.previewUrl === '' && state.sourceUrl === baseline.sourceUrl && state.downloadDisabled) {
        return { gate, state }
      }
      throw new Error(`AX pending ownership was not held without a completed result: ${JSON.stringify({ baseline, gate, state })}`)
    }, 'the pending AX ownership state', PR8_ASSERTION_TIMEOUT_MS)
    const pendingComparison = await readComparisonState(cdp, sessionId)
    assert(pendingComparison.source?.visible && pendingComparison.crop?.visible && pendingComparison.processedInCropCount === 0 && pendingComparison.pendingMaskCount === 0, `The pending comparison covered the separate crop editor: ${JSON.stringify({ pending, pendingComparison })}`)
    const pendingAx = await readMode('pending')
    assert(await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.injectError("E2E AX pending encode failure")') === true, 'The pending AX Worker request did not accept the injected error.')
    const failed = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (state.error === 'E2E AX pending encode failure' && state.status === 'エラー' && state.busy === false && state.pending === false && state.previewUrl === '' && state.sourceUrl === baseline.sourceUrl && state.downloadDisabled) {
        return state
      }
      throw new Error(`AX error fallback did not settle with the committed source: ${JSON.stringify({ baseline, pending, state })}`)
    }, 'the AX error fallback state', PR8_ASSERTION_TIMEOUT_MS)
    const failedComparison = await readComparisonState(cdp, sessionId)
    assert(failedComparison.source?.visible && failedComparison.crop?.visible && failedComparison.processedInCropCount === 0, `The error fallback did not preserve the separate crop editor: ${JSON.stringify({ failed, failedComparison })}`)
    const failedAx = await readMode('pending')

    const restored = await restoreReadySource(cdp, sessionId, fixturePath, 'AX ownership restore', '16 × 32 px')
    await activateComparisonModeWithMouse(cdp, sessionId, 'compare')
    const restoredAx = await readMode('compare')
    assert(restored.ready.error === '' && restored.ready.busy === false && restored.ready.pending === false && restored.ready.previewUrl.startsWith('blob:'), `AX ownership restore did not return to a completed preview: ${JSON.stringify(restored)}`)

    await activateComparisonModeWithMouse(cdp, sessionId, 'original')
    const original = await readMode('original')
    await activateComparisonModeWithMouse(cdp, sessionId, 'result')
    const result = await readMode('result')
    return { compared, failed, failedAx, labels, original, pending, pendingAx, result, restored, restoredAx }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
  }
}

async function runNoopOutputInvalidationRegression({ cdp, fixturePath, selector, sessionId, valueKey, label }) {
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, `${label} baseline`, '16 × 32 px')
  const before = restored.ready
  const value = valueKey === 'quality' ? before.quality : before.outputMime
  assert(valueKey === 'quality' ? Number.isFinite(value) : value.length > 0, `${label} has no current control value: ${JSON.stringify(before)}`)
  await setControlValue(cdp, sessionId, selector, value)
  const after = await waitFor(async () => {
    const state = await readPr8State(cdp, sessionId)
    if (
      state.sourceUrl === before.sourceUrl &&
      state.previewUrl === before.previewUrl &&
      state.status === 'プレビュー準備完了' &&
      state.busy === false &&
      state.pending === false &&
      state.downloadDisabled === false
    ) {
      return state
    }
    throw new Error(`${label} invalidated a result despite an unchanged value: ${JSON.stringify({ before, after: state })}`)
  }, `${label} to preserve the completed result`, PR8_ASSERTION_TIMEOUT_MS)
  return { after, before, value }
}

async function runCancelledExportSelectionRegression({ candidateFixturePath, cdp, downloadDirectory, expectedSourceDimensions, fixturePath, sessionId }) {
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, 'cancelled export baseline', '16 × 32 px')
  const baseline = restored.ready
  const filesBefore = (await readdir(downloadDirectory)).sort()
  try {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await clickButton(cdp, sessionId, 'ダウンロード')
    const heldExport = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.busy && state.downloadDisabled && state.previewUrl === baseline.previewUrl && state.pending === false) {
        return { gate, state }
      }
      throw new Error(`Export was not held with the retained preview: ${JSON.stringify({ baseline, gate, state })}`)
    }, 'the held export before candidate selection', PR8_ASSERTION_TIMEOUT_MS)

    await setFileInput(cdp, sessionId, candidateFixturePath)
    let outcome
    if (expectedSourceDimensions) {
      const committed = await waitFor(async () => {
        const state = await readPr8State(cdp, sessionId)
        if (state.sourceUrl !== baseline.sourceUrl && state.sourceDimensions === expectedSourceDimensions) {
          return state
        }
        throw new Error(`Successful candidate has not committed after export cancellation: ${JSON.stringify({ baseline, state })}`)
      }, 'the successful candidate commit after export cancellation', PR8_ASSERTION_TIMEOUT_MS)
      const released = await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.release()')
      assert(released === true, 'The cancelled export was not released from the Worker gate.')
      const ready = await waitFor(async () => {
        const state = await readPr8State(cdp, sessionId)
        if (state.status === 'プレビュー準備完了' && state.busy === false && state.pending === false && state.previewUrl.startsWith('blob:') && state.sourceUrl === committed.sourceUrl && state.sourceDimensions === expectedSourceDimensions) {
          return state
        }
        throw new Error(`Successful candidate did not settle after cancelling export: ${JSON.stringify({ committed, state })}`)
      }, 'the successful candidate preview after export cancellation', PR8_ASSERTION_TIMEOUT_MS)
      outcome = { committed, heldExport, ready }
    } else {
      const failed = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
        if (state.error.length > 0 && hasUsablePreview(state) && state.previewUrl === baseline.previewUrl && state.sourceUrl === baseline.sourceUrl) {
          return state
        }
        throw new Error(`Failed candidate has not settled with the retained export preview: ${JSON.stringify({ baseline, state })}`)
      }, 'the failed candidate after export cancellation', PR8_ASSERTION_TIMEOUT_MS)
      const released = await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.release()')
      assert(released === true, 'The cancelled export for a failed candidate was not released from the Worker gate.')
      const afterRelease = await waitFor(async () => {
        const state = await readPr8State(cdp, sessionId)
        if (state.error === failed.error && hasUsablePreview(state) && state.previewUrl === baseline.previewUrl && state.sourceUrl === baseline.sourceUrl) {
          return state
        }
        throw new Error(`Cancelled export changed the retained result after failed candidate completion: ${JSON.stringify({ failed, state })}`)
      }, 'the retained preview after releasing the cancelled failed export', PR8_ASSERTION_TIMEOUT_MS)
      outcome = { failed, heldExport, afterRelease }
    }

    const filesAfter = (await readdir(downloadDirectory)).sort()
    assert(JSON.stringify(filesAfter) === JSON.stringify(filesBefore), `Candidate selection produced a cancelled export download: ${JSON.stringify({ filesBefore, filesAfter })}`)
    return outcome
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
  }
}

async function runCancelledExportEditRegression({ cdp, downloadDirectory, fixturePath, sessionId }) {
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, 'cancelled export edit baseline', '16 × 32 px')
  const baseline = restored.ready
  const filesBefore = (await readdir(downloadDirectory)).sort()
  try {
    const nextQuality = Math.abs(baseline.quality - 0.57) < 0.001 ? 0.71 : 0.57
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await clickButton(cdp, sessionId, 'ダウンロード')
    const heldExport = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.busy && state.downloadDisabled && state.previewUrl === baseline.previewUrl && state.pending === false) {
        return { gate, state }
      }
      throw new Error(`Export was not held before edit: ${JSON.stringify({ baseline, gate, state })}`)
    }, 'the held export before edit', PR8_ASSERTION_TIMEOUT_MS)

    await setControlValue(cdp, sessionId, '#quality', nextQuality)
    const readyBeforeRelease = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (
        gate?.held &&
        state.quality === nextQuality &&
        state.status === 'プレビュー準備完了' &&
        state.busy === false &&
        state.pending === false &&
        state.previewUrl.startsWith('blob:') &&
        state.previewUrl !== baseline.previewUrl &&
        state.sourceUrl === baseline.sourceUrl &&
        state.downloadDisabled === false
      ) {
        return state
      }
      throw new Error(`The current edited preview was not ready while the old export remained held: ${JSON.stringify({ baseline, heldExport, gate, state })}`)
    }, 'the ready edited preview before releasing the old export', PR8_ASSERTION_TIMEOUT_MS)

    assert(await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.release()') === true, 'The obsolete export was not released after the edited preview became ready.')
    const afterRelease = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (
        state.quality === nextQuality &&
        state.status === 'プレビュー準備完了' &&
        state.busy === false &&
        state.pending === false &&
        state.previewUrl === readyBeforeRelease.previewUrl &&
        state.sourceUrl === readyBeforeRelease.sourceUrl &&
        state.downloadDisabled === false
      ) {
        return state
      }
      throw new Error(`Releasing the obsolete export changed the current edited preview: ${JSON.stringify({ readyBeforeRelease, state })}`)
    }, 'the unchanged edited preview after releasing the old export', PR8_ASSERTION_TIMEOUT_MS)
    const filesAfter = (await readdir(downloadDirectory)).sort()
    assert(JSON.stringify(filesAfter) === JSON.stringify(filesBefore), `The obsolete export produced a download after edit: ${JSON.stringify({ filesBefore, filesAfter })}`)
    return { afterRelease, baseline, heldExport, readyBeforeRelease }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
  }
}

async function runLatestCandidateOrderingRegression({ cdp, cropDragFixturePath, decodeSupported, fixturePath, sessionId }) {
  if (!decodeSupported) {
    return { reason: 'createImageBitmap is unavailable for the deterministic decode gate.', skipped: true }
  }
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, 'latest candidate baseline', '16 × 32 px')
  const baseline = restored.ready
  try {
    await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.arm()')
    await setFileInput(cdp, sessionId, cropDragFixturePath)
    const firstHeld = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readDecodeGate(cdp, sessionId)
      if (gate?.held && state.busy && state.sourceUrl === baseline.sourceUrl && state.previewUrl === baseline.previewUrl && state.pending === false) {
        return { gate, state }
      }
      throw new Error(`The first candidate was not held against the committed source: ${JSON.stringify({ baseline, gate, state })}`)
    }, 'the first held candidate decode', PR8_ASSERTION_TIMEOUT_MS)

    await setFileInput(cdp, sessionId, fixturePath)
    const latest = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (state.sourceUrl !== baseline.sourceUrl && state.sourceDimensions === '16 × 32 px' && state.status === 'プレビュー準備完了' && state.busy === false && state.pending === false && state.previewUrl.startsWith('blob:')) {
        return state
      }
      throw new Error(`The latest candidate has not committed while the first decode is held: ${JSON.stringify({ baseline, firstHeld, state })}`)
    }, 'the latest candidate preview before releasing the obsolete decode', PR8_ASSERTION_TIMEOUT_MS)

    const released = await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.release()')
    assert(released === true, 'The obsolete first candidate decode was not released.')
    const afterObsolete = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (state.sourceUrl === latest.sourceUrl && state.sourceDimensions === '16 × 32 px' && state.previewUrl === latest.previewUrl && state.status === 'プレビュー準備完了' && state.busy === false && state.pending === false) {
        return state
      }
      throw new Error(`An obsolete candidate won after the latest candidate committed: ${JSON.stringify({ latest, state })}`)
    }, 'the latest candidate after releasing the obsolete decode', PR8_ASSERTION_TIMEOUT_MS)
    return { afterObsolete, baseline, firstHeld, latest }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.held ? window.__e2eDecodeGate.release() : false').catch(() => {})
  }
}

async function runComparisonCommitRegression({ cdp, cropDragFixturePath, fixturePath, sessionId }) {
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, 'comparison commit baseline', '16 × 32 px')
  const baseline = restored.ready
  try {
    await activateComparisonModeWithMouse(cdp, sessionId, 'original')
    await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.arm()')
    await setFileInput(cdp, sessionId, cropDragFixturePath)
    const heldDecode = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readDecodeGate(cdp, sessionId)
      if (gate?.held && state.busy && state.downloadDisabled && state.sourceUrl === baseline.sourceUrl && state.previewUrl === baseline.previewUrl && state.pending === false) {
        return { gate, state }
      }
      throw new Error(`Candidate decode was not held against the committed preview before comparison: ${JSON.stringify({ baseline, gate, state })}`)
    }, 'the held candidate decode before comparison press', PR8_ASSERTION_TIMEOUT_MS)

    const pendingComparison = await readComparisonState(cdp, sessionId)
    assert(pendingComparison.comparisonMode === 'original' && pendingComparison.resultLayer?.visibility === 'hidden', `Candidate decode changed the persistent original comparison: ${JSON.stringify({ heldDecode, pendingComparison })}`)
    assert(pendingComparison.source?.visible && pendingComparison.crop?.visible && pendingComparison.processedInCropCount === 0 && pendingComparison.pendingMaskCount === 0, `Candidate decode covered the separate crop editor: ${JSON.stringify({ heldDecode, pendingComparison })}`)

    assert(await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.release()') === true, 'The candidate decode was not released after pressing comparison.')
    const committed = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const comparison = await readComparisonState(cdp, sessionId)
      if (
        state.sourceUrl !== baseline.sourceUrl &&
        state.sourceDimensions === '1000 × 600 px' &&
        state.status === 'プレビュー準備完了' &&
        state.busy === false &&
        state.pending === false &&
        state.previewUrl.startsWith('blob:') &&
        comparison.comparisonMode === 'original' &&
        comparison.resultLayer?.visibility === 'hidden' &&
        comparison.source?.visible &&
        comparison.crop?.visible &&
        comparison.processedInCropCount === 0 &&
        comparison.pendingMaskCount === 0
      ) {
        return { comparison, state }
      }
      throw new Error(`Candidate commit did not preserve the selected comparison and separate crop editor: ${JSON.stringify({ baseline, heldDecode, comparison, state })}`)
    }, 'the compressed default after candidate commit releases comparison', PR8_ASSERTION_TIMEOUT_MS)
    await activateComparisonModeWithMouse(cdp, sessionId, 'compare')
    const compared = await readComparisonState(cdp, sessionId)
    assert(compared.comparisonMode === 'compare' && compared.resultImage?.visible, `Candidate commit did not expose the new comparison result: ${JSON.stringify({ committed, compared })}`)
    return { baseline, committed, compared, heldDecode, pendingComparison }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.held ? window.__e2eDecodeGate.release() : false').catch(() => {})
  }
}

async function runFailedEncodeSettlementRegression({ cdp, fixturePath, sessionId }) {
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, 'injected encode failure baseline', '16 × 32 px')
  try {
    const baseline = restored.ready
    const nextQuality = Math.abs(baseline.quality - 0.57) < 0.001 ? 0.71 : 0.57
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await setControlValue(cdp, sessionId, '#quality', nextQuality)
    const held = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.busy && state.pending && state.previewUrl === '' && state.downloadDisabled) {
        return { gate, state }
      }
      throw new Error(`The preview request for injected encode failure was not held: ${JSON.stringify({ baseline, gate, state })}`)
    }, 'the held preview before injecting a Worker encode error', PR8_ASSERTION_TIMEOUT_MS)

    const injected = await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.injectError("E2E injected Worker encode failure")')
    assert(injected === true, 'The held Worker request did not accept the injected encode error.')
    const failed = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (state.error === 'E2E injected Worker encode failure' && state.status === 'エラー' && state.busy === false && state.pending === false && state.previewUrl === '' && state.downloadDisabled && state.sourceUrl === baseline.sourceUrl) {
        return state
      }
      throw new Error(`Injected Worker encode failure did not settle the preview state: ${JSON.stringify({ baseline, held, state })}`)
    }, 'the settled UI after an injected Worker encode error', PR8_ASSERTION_TIMEOUT_MS)
    return { baseline, failed, held }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
  }
}

async function runPendingInvalidReplacementRegression({ cdp, fixturePath, invalidFixturePath, pendingFixturePath, phase, sessionId, invalidLabel }) {
  const baselineRestore = await restoreReadySource(cdp, sessionId, fixturePath, `${phase} ${invalidLabel} baseline`, '16 × 32 px')
  let pendingState
  try {
    const baseline = baselineRestore.ready
    const gateBefore = await readWorkerProcessGate(cdp, sessionId)
    assert(gateBefore, 'The Worker process gate was not installed for the pending replacement regression.')
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')

    if (phase === 'initial in-flight') {
      await setFileInput(cdp, sessionId, pendingFixturePath)
      await waitForDom(cdp, sessionId, `document.querySelector('.stage-image')?.src !== ${JSON.stringify(baseline.sourceUrl)} && document.querySelector('.metrics-card .metric-line:first-child strong')?.textContent?.trim() === '1000 × 600 px'`, `${invalidLabel} pending source commit`)
    } else {
      await openDetails(cdp, sessionId, '.advanced-controls')
      await setControlValue(cdp, sessionId, '#resize-width', '8')
      await waitForDom(cdp, sessionId, `document.querySelector('.effective-size strong')?.textContent?.trim() === '8 × 16 px'`, `${invalidLabel} edited output dimensions`)
    }

    const pending = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.pending && state.previewUrl === '' && state.downloadDisabled) {
        return { gate, state }
      }
      throw new Error(`${phase} ${invalidLabel} did not reach a held Worker preview: ${JSON.stringify({ gate, state })}`)
    }, `${phase} ${invalidLabel} Worker/debounce pending state`, PR8_ASSERTION_TIMEOUT_MS)
    pendingState = pending.state

    await setFileInput(cdp, sessionId, invalidFixturePath)
    const failure = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (
        state.error.length > 0 &&
        state.status === 'エラー' &&
        state.busy === pendingState.busy &&
        state.pending === pendingState.pending &&
        state.previewUrl === pendingState.previewUrl &&
        state.sourceUrl === pendingState.sourceUrl &&
        state.downloadDisabled
      ) {
        return state
      }
      throw new Error(`${phase} ${invalidLabel} candidate failure has not settled independently of the current preview: ${JSON.stringify({ pending: pendingState, state })}`)
    }, `${phase} ${invalidLabel} decode/selection failure completion`, PR8_ASSERTION_TIMEOUT_MS)
    assert(failure.sourceUrl === pendingState.sourceUrl, `${phase} ${invalidLabel} changed the committed source during a failed replacement: ${JSON.stringify({ pending: pendingState, failure })}`)

    const released = await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.release()')
    assert(released === true, `${phase} ${invalidLabel} did not release the held Worker request.`)
    const recovered = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (hasUsablePreview(state) && state.sourceUrl.length > 0) {
        return state
      }
      throw new Error(`${phase} ${invalidLabel} left no usable current preview after the failure: ${JSON.stringify(state)}`)
    }, `${phase} ${invalidLabel} current preview recovery`, PR8_ASSERTION_TIMEOUT_MS)

    const identityCandidates = phase === 'initial in-flight'
      ? [
          {
            naturalHeight: baselineRestore.ready.previewNaturalHeight,
            naturalWidth: baselineRestore.ready.previewNaturalWidth,
            sourceDimensions: baseline.sourceDimensions,
            sourceUrl: baseline.sourceUrl,
          },
          {
            naturalHeight: 576,
            naturalWidth: 960,
            sourceDimensions: '1000 × 600 px',
            sourceUrl: pendingState.sourceUrl,
          },
        ]
      : [{
          naturalHeight: 16,
          naturalWidth: 8,
          sourceDimensions: baseline.sourceDimensions,
          sourceUrl: baseline.sourceUrl,
        }]
    const identityMatches = identityCandidates.some((candidate) => (
      recovered.sourceUrl === candidate.sourceUrl &&
      recovered.sourceDimensions === candidate.sourceDimensions &&
      recovered.previewNaturalWidth === candidate.naturalWidth &&
      recovered.previewNaturalHeight === candidate.naturalHeight
    ))
    assert(identityMatches, `${phase} ${invalidLabel} recovered a mixed or stale source/result identity: ${JSON.stringify({ baseline, pending: pendingState, failure, recovered, identityCandidates })}`)
    assert(recovered.error === failure.error, `${phase} ${invalidLabel} preview completion erased the replacement error: ${JSON.stringify({ failure, recovered })}`)
    return { baseline, failure, pending: pendingState, recovered }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
  }
}

async function runPreDebounceInvalidReplacementRegression({ cdp, fixturePath, invalidFixturePath, invalidLabel, pendingFixturePath, sessionId }) {
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, `before-debounce ${invalidLabel} baseline`, '16 × 32 px')
  let pendingState
  try {
    const baseline = restored.ready
    assert(await readPreviewDebounceGate(cdp, sessionId), 'The preview debounce gate was not installed for the before-debounce replacement regression.')
    await evaluate(cdp, sessionId, 'window.__e2ePreviewDebounceGate.arm()')
    await setFileInput(cdp, sessionId, pendingFixturePath)
    const pending = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readPreviewDebounceGate(cdp, sessionId)
      if (gate?.held && state.busy && state.pending && state.previewUrl === '' && state.sourceUrl !== baseline.sourceUrl && state.sourceDimensions === '1000 × 600 px' && state.downloadDisabled) {
        return { gate, state }
      }
      throw new Error(`The ${invalidLabel} before-debounce preview was not held before the 160ms callback: ${JSON.stringify({ baseline, gate, state })}`)
    }, `the held 160ms preview debounce before ${invalidLabel}`, PR8_ASSERTION_TIMEOUT_MS)
    pendingState = pending.state

    await setFileInput(cdp, sessionId, invalidFixturePath)
    const failure = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readPreviewDebounceGate(cdp, sessionId)
      if (
        gate?.held &&
        state.error.length > 0 &&
        state.status === 'エラー' &&
        state.busy === pendingState.busy &&
        state.pending === pendingState.pending &&
        state.previewUrl === pendingState.previewUrl &&
        state.sourceUrl === pendingState.sourceUrl &&
        state.downloadDisabled
      ) {
        return state
      }
      throw new Error(`The ${invalidLabel} rejection did not settle before the 160ms preview callback: ${JSON.stringify({ pending: pendingState, gate, state })}`)
    }, `${invalidLabel} rejection before the initial 160ms debounce`, PR8_ASSERTION_TIMEOUT_MS)

    assert(await evaluate(cdp, sessionId, 'window.__e2ePreviewDebounceGate.release()') === true, `The held 160ms preview debounce did not release after ${invalidLabel} rejection.`)
    const recovered = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (
        hasUsablePreview(state) &&
        state.sourceUrl === pendingState.sourceUrl &&
        state.sourceDimensions === '1000 × 600 px' &&
        state.previewNaturalWidth === 960 &&
        state.previewNaturalHeight === 576 &&
        state.error === failure.error
      ) {
        return state
      }
      throw new Error(`The ${invalidLabel} rejection did not preserve the current preview after the 160ms callback: ${JSON.stringify({ failure, pending: pendingState, state })}`)
    }, `${invalidLabel} current preview after releasing the initial debounce`, PR8_ASSERTION_TIMEOUT_MS)
    return { baseline, failure, pending: pendingState, recovered }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2ePreviewDebounceGate.disarm()').catch(() => {})
  }
}

async function runConcurrentDecodeEditResetRegression({ cdp, fixturePath, sessionId, decodeSupported }) {
  if (!decodeSupported) {
    return { reason: 'createImageBitmap is unavailable for the deterministic decode gate.', skipped: true }
  }
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, 'decode/edit/reset baseline', '16 × 32 px')
  try {
    const baseline = restored.ready
    const currentQuality = baseline.quality
    const nextQuality = Math.abs(currentQuality - 0.57) < 0.001 ? 0.71 : 0.57
    await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.arm(); window.__e2eWorkerProcessGate.arm()')
    await setFileInput(cdp, sessionId, fixturePath)
    const heldDecode = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readDecodeGate(cdp, sessionId)
      if (
        gate?.held &&
        state.busy &&
        state.downloadDisabled &&
        state.sourceUrl === baseline.sourceUrl &&
        state.previewUrl === baseline.previewUrl &&
        state.pending === false
      ) {
        return { gate, state }
      }
      throw new Error(`Concurrent decode did not remain a candidate against the retained committed preview: ${JSON.stringify({ baseline, gate, state })}`)
    }, 'the held replacement decode before edit/reset', PR8_ASSERTION_TIMEOUT_MS)

    await setControlValue(cdp, sessionId, '#quality', nextQuality)
    const heldWorker = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      const gate = await readWorkerProcessGate(cdp, sessionId)
      if (gate?.held && state.pending && state.previewUrl === '') {
        return { gate, state }
      }
      throw new Error(`Edit did not produce a held preview while decode was pending: ${JSON.stringify({ gate, state })}`)
    }, 'the held edit preview before reset', PR8_ASSERTION_TIMEOUT_MS)

    await clickButton(cdp, sessionId, '編集をリセット')
    await waitForDom(cdp, sessionId, `[...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value).join(',') === '0,0,16,32'`, 'the reset edit state while decode and Worker work are pending')
    assert(await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.release()') === true, 'The held edit Worker request was not released after reset.')
    assert(await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.release()') === true, 'The held replacement decode was not released after reset.')

    const recovered = await waitFor(async () => {
      const state = await readPr8State(cdp, sessionId)
      if (state.status === 'プレビュー準備完了' && state.busy === false && state.pending === false && state.previewUrl.startsWith('blob:') && state.sourceUrl === baseline.sourceUrl && state.sourceDimensions === '16 × 32 px' && state.previewNaturalWidth === 16 && state.previewNaturalHeight === 32) {
        return state
      }
      throw new Error(`Reset did not win the concurrent decode/edit race: ${JSON.stringify({ baseline, heldDecode, heldWorker, state })}`)
    }, 'the current preview after concurrent decode/edit/reset', PR8_ASSERTION_TIMEOUT_MS)
    return { baseline, heldDecode, heldWorker, recovered }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
    await evaluate(cdp, sessionId, 'window.__e2eDecodeGate.held ? window.__e2eDecodeGate.release() : false').catch(() => {})
  }
}

async function runTinyCropComparisonRegression({ cdp, cropDragFixturePath, fixturePath, sessionId }) {
  await restoreReadySource(cdp, sessionId, cropDragFixturePath, 'tiny crop source', '1000 × 600 px')
  try {
    await openDetails(cdp, sessionId, '.advanced-controls')
    await setControlValue(cdp, sessionId, '#aspect-ratio', 'free')
    const cropInputSelectors = [1, 2, 3, 4].map((index) => `.crop-coordinates label:nth-child(${index}) input`)
    const readLayout = () => evaluate(cdp, sessionId, `(() => {
      const describe = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          minHeight: style.minHeight,
          minWidth: style.minWidth,
          right: rect.right,
          top: rect.top,
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          width: rect.width,
        }
      }
      return {
        crop: describe('.crop-rectangle'),
        guide: describe('.crop-guide'),
        mask: {
          bottom: describe('.crop-shade-bottom'),
          left: describe('.crop-shade-left'),
          right: describe('.crop-shade-right'),
          top: describe('.crop-shade-top'),
        },
        comparison: {
          canvas: describe('.comparison-canvas'),
          empty: describe('.comparison-empty'),
          original: describe('.comparison-original-layer'),
          result: describe('.comparison-result-image'),
          viewport: describe('.comparison-viewport'),
        },
        stageProcessedCount: document.querySelectorAll('.stage-area .processed-preview').length,
        surface: describe('.crop-surface'),
      }
    })()`)
    const assertCropGeometry = (layout, description) => {
      assert(layout.crop && layout.surface, `${description} crop evidence is incomplete: ${JSON.stringify(layout)}`)
      assert(layout.crop.width < 8 && layout.crop.height < 8, `${description} retained a large visual minimum: ${JSON.stringify(layout)}`)
      assert(layout.crop.minWidth === '0px' && layout.crop.minHeight === '0px', `${description} uses a crop layout minimum: ${JSON.stringify(layout)}`)
      const maskErrors = {
        bottom: Math.abs(layout.mask.bottom.top - layout.crop.bottom),
        left: Math.abs(layout.mask.left.right - layout.crop.left),
        right: Math.abs(layout.mask.right.left - layout.crop.right),
        top: Math.abs(layout.mask.top.bottom - layout.crop.top),
      }
      assert(Math.max(...Object.values(maskErrors)) <= 1.5, `${description} mask boundaries do not share the crop rectangle source of truth: ${JSON.stringify({ layout, maskErrors })}`)
      assert(layout.guide?.visible && Math.abs(layout.guide.left - layout.crop.left) <= 1.5 && Math.abs(layout.guide.right - layout.crop.right) <= 1.5 && Math.abs(layout.guide.top - layout.crop.top) <= 1.5 && Math.abs(layout.guide.bottom - layout.crop.bottom) <= 1.5, `${description} guide bounds do not follow the crop rectangle: ${JSON.stringify(layout)}`)
      assert(layout.stageProcessedCount === 0, `${description} put an encoded result back into the crop stage: ${JSON.stringify(layout)}`)
      return maskErrors
    }
    const assertSeparateComparison = (layout, description) => {
      const target = layout.comparison.canvas ?? layout.comparison.viewport
      const result = layout.comparison.result
      assert(target && result, `${description} comparison result evidence is incomplete: ${JSON.stringify(layout)}`)
      const aligned = (rect) => Math.abs(rect.left - target.left) <= 1 &&
        Math.abs(rect.right - target.right) <= 1 &&
        Math.abs(rect.top - target.top) <= 1 &&
        Math.abs(rect.bottom - target.bottom) <= 1
      assert(aligned(result), `${description} result is not aligned to the separate comparison frame: ${JSON.stringify({ comparison: layout.comparison, crop: layout.crop })}`)
      assert(result.width > layout.crop.width * 10 && result.height > layout.crop.height * 10, `${description} comparison result was incorrectly sized from the tiny crop frame: ${JSON.stringify({ comparison: layout.comparison, crop: layout.crop })}`)
    }
    const setTinyCrop = async (x, y, width, height, description) => {
      for (const [selector, value] of [[cropInputSelectors[0], x], [cropInputSelectors[1], y], [cropInputSelectors[2], width], [cropInputSelectors[3], height]]) {
        await setControlValue(cdp, sessionId, selector, value)
      }
      await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了' && [...document.querySelectorAll('.crop-coordinates input')].map((input) => input.value).join(',') === ${JSON.stringify(`${x},${y},${width},${height}`)} && document.querySelector('.processed-preview')?.naturalWidth === ${width} && document.querySelector('.processed-preview')?.naturalHeight === ${height}`, `${description} completed preview`)
    }
    const assertEdge = (layout, edge, description) => {
      const edgeErrors = edge === 'top-left'
        ? { left: Math.abs(layout.crop.left - layout.surface.left), top: Math.abs(layout.crop.top - layout.surface.top) }
        : { bottom: Math.abs(layout.surface.bottom - layout.crop.bottom), right: Math.abs(layout.surface.right - layout.crop.right) }
      assert(Math.max(...Object.values(edgeErrors)) <= 1.5, `${description} crop is not aligned to the ${edge} surface edge: ${JSON.stringify({ layout, edgeErrors })}`)
    }

    const cases = []
    for (const [viewportName, viewport] of [['desktop', DESKTOP_VIEWPORT], ['mobile', MOBILE_VIEWPORT]]) {
      await setViewport(cdp, sessionId, viewport)
      await waitForDom(cdp, sessionId, `window.innerWidth === ${viewport.width} && window.innerHeight === ${viewport.height}`, `the ${viewportName} tiny crop viewport`)
      for (const [edge, x, y] of [['top-left', 0, 0], ['right-bottom', 999, 599]]) {
        await setTinyCrop(x, y, 1, 1, `${viewportName} ${edge} tiny crop`)
        const completedLayout = await readLayout()
        const previewMaskErrors = assertCropGeometry(completedLayout, `${viewportName} ${edge} completed tiny crop`)
        assertSeparateComparison(completedLayout, `${viewportName} ${edge} completed tiny crop`)
        assertEdge(completedLayout, edge, `${viewportName} ${edge} completed tiny crop`)

        const currentState = await readPr8State(cdp, sessionId)
        const nextQuality = Math.abs(currentState.quality - 0.57) < 0.001 ? 0.71 : 0.57
        await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
        await setControlValue(cdp, sessionId, '#quality', nextQuality)
        await waitFor(async () => {
          const state = await readPr8State(cdp, sessionId)
          const gate = await readWorkerProcessGate(cdp, sessionId)
          if (gate?.held && state.busy && state.pending && state.previewUrl === '' && state.downloadDisabled && state.crop.join(',') === `${x},${y},1,1`) {
            return { gate, state }
          }
          throw new Error(`${viewportName} ${edge} tiny crop did not reach a held preview request: ${JSON.stringify({ gate, state })}`)
        }, `${viewportName} ${edge} held tiny preview request`, PR8_ASSERTION_TIMEOUT_MS)
        const pendingLayout = await readLayout()
        const pendingMaskErrors = assertCropGeometry(pendingLayout, `${viewportName} ${edge} pending tiny crop`)
        assertEdge(pendingLayout, edge, `${viewportName} ${edge} pending tiny crop`)
        assert(pendingLayout.comparison.empty?.visible && pendingLayout.comparison.result === null, `${viewportName} ${edge} pending preview did not clear the separate comparison result: ${JSON.stringify(pendingLayout)}`)
        assert(await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.release()') === true, `${viewportName} ${edge} held tiny preview request was not released.`)
        await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了' && document.querySelector('.processed-preview')?.naturalWidth === 1 && document.querySelector('.processed-preview')?.naturalHeight === 1`, `${viewportName} ${edge} restored tiny preview`)
        cases.push({ edge, pending: pendingLayout, pendingMaskErrors, preview: completedLayout, previewMaskErrors, viewport: viewportName })
      }
    }
    return { cases }
  } finally {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.disarm()').catch(() => {})
    await setViewport(cdp, sessionId, DESKTOP_VIEWPORT).catch(() => {})
    await restoreReadySource(cdp, sessionId, fixturePath, 'tiny crop cleanup', '16 × 32 px')
  }
}

async function runPr8AdditionalFindingsRegression({ cdp, corruptFixturePath, cropDragFixturePath, downloadDirectory, fixturePath, sessionId, unsupportedFixturePath }) {
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport for PR8 additional regressions')
  await restoreReadySource(cdp, sessionId, fixturePath, 'PR8 initial source', '16 × 32 px')

  const cases = []
  let decodeGate
  try {
    await installWorkerProcessGate(cdp, sessionId)
    decodeGate = await installDecodeGate(cdp, sessionId)
    await installPreviewDebounceGate(cdp, sessionId)
    cases.push(await runLoggedPr8Case('same quality value does not invalidate the completed result', () => runNoopOutputInvalidationRegression({ cdp, fixturePath, label: 'same quality', selector: '#quality', sessionId, valueKey: 'quality' })))
    cases.push(await runLoggedPr8Case('same MIME value does not invalidate the completed result', () => runNoopOutputInvalidationRegression({ cdp, fixturePath, label: 'same output MIME', selector: '#output-format', sessionId, valueKey: 'mime', })))
    for (const invalidCase of [
      { fixturePath: corruptFixturePath, label: 'corrupt replacement' },
      { fixturePath: unsupportedFixturePath, label: 'unsupported replacement' },
    ]) {
      cases.push(await runLoggedPr8Case(`${invalidCase.label} before the initial 160ms debounce`, () => runPreDebounceInvalidReplacementRegression({ cdp, fixturePath, invalidFixturePath: invalidCase.fixturePath, invalidLabel: invalidCase.label, pendingFixturePath: cropDragFixturePath, sessionId })))
      cases.push(await runLoggedPr8Case(`${invalidCase.label} during initial in-flight preview`, () => runPendingInvalidReplacementRegression({ cdp, fixturePath, invalidFixturePath: invalidCase.fixturePath, invalidLabel: invalidCase.label, pendingFixturePath: cropDragFixturePath, phase: 'initial in-flight', sessionId })))
      cases.push(await runLoggedPr8Case(`${invalidCase.label} during edited in-flight preview`, () => runPendingInvalidReplacementRegression({ cdp, fixturePath, invalidFixturePath: invalidCase.fixturePath, invalidLabel: invalidCase.label, pendingFixturePath: cropDragFixturePath, phase: 'edited pending', sessionId })))
    }
    for (const exportCase of [
      { candidateFixturePath: cropDragFixturePath, expectedSourceDimensions: '1000 × 600 px', label: 'successful' },
      { candidateFixturePath: corruptFixturePath, expectedSourceDimensions: undefined, label: 'failed' },
    ]) {
      cases.push(await runLoggedPr8Case(`cancelled export with ${exportCase.label} candidate`, () => runCancelledExportSelectionRegression({ ...exportCase, cdp, downloadDirectory, fixturePath, sessionId })))
    }
    cases.push(await runLoggedPr8Case('cancelled export cannot block an edited current preview', () => runCancelledExportEditRegression({ cdp, downloadDirectory, fixturePath, sessionId })))
    cases.push(await runLoggedPr8Case('latest candidate wins after obsolete decode', () => runLatestCandidateOrderingRegression({ cdp, cropDragFixturePath, decodeSupported: decodeGate?.supported === true, fixturePath, sessionId })))
    cases.push(await runLoggedPr8Case('concurrent decode plus edit/reset keeps the committed source current', () => runConcurrentDecodeEditResetRegression({ cdp, decodeSupported: decodeGate?.supported === true, fixturePath, sessionId })))
    cases.push(await runLoggedPr8Case('candidate commit releases comparison pressed during decode', () => runComparisonCommitRegression({ cdp, cropDragFixturePath, fixturePath, sessionId })))
    cases.push(await runLoggedPr8Case('injected Worker encode failure settles', () => runFailedEncodeSettlementRegression({ cdp, fixturePath, sessionId })))
    cases.push(await runLoggedPr8Case('compressed/original AX image ownership', () => runAccessibilityOcclusionRegression({ cdp, fixturePath, sessionId })))
    cases.push(await runLoggedPr8Case('tiny crop rectangle, crop masks, and separate comparison bounds', () => runTinyCropComparisonRegression({ cdp, cropDragFixturePath, fixturePath, sessionId })))

    const redCases = cases.filter((result) => result.status === 'red')
    assert(redCases.length === 0, `PR8 additional browser regressions remain red: ${JSON.stringify(redCases.map(({ label, error }) => ({ error, label })))}`)
    return { cases, redCases }
  } finally {
    await removeE2EGates(cdp, sessionId).catch(() => {})
  }
}

async function runRoundedPreviewRegression({ cdp, fixturePath, sessionId }) {
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await waitForDom(cdp, sessionId, `window.innerWidth === ${DESKTOP_VIEWPORT.width} && window.innerHeight === ${DESKTOP_VIEWPORT.height}`, 'the desktop viewport for the rounded preview')
  const fixtureDataUrl = await evaluate(cdp, sessionId, `(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 5
    canvas.height = 5
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create a 2D canvas context for the rounded preview fixture.')
    const colors = ['#e63946', '#457b9d', '#f4a261', '#2a9d8f']
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        context.fillStyle = colors[(row < 3 ? 0 : 2) + (column < 3 ? 0 : 1)]
        context.fillRect(column, row, 1, 1)
      }
    }
    return canvas.toDataURL('image/png')
  })()`)
  const encodedFixture = fixtureDataUrl?.match(/^data:image\/png;base64,(.+)$/)?.[1]
  assert(encodedFixture, 'Rounded preview fixture did not encode as a PNG data URL.')
  await writeFile(fixturePath, Buffer.from(encodedFixture, 'base64'))

  await setFileInput(cdp, sessionId, fixturePath)
  await waitForDom(cdp, sessionId, `document.querySelector('.metrics-card .metric-line:first-child strong')?.textContent?.trim() === '5 × 5 px'`, 'the rounded preview source dimensions')
  await setControlValue(cdp, sessionId, '#aspect-ratio', '4:3')
  const layout = await waitFor(async () => {
    const next = await captureToolLayout(cdp, sessionId)
    if (
      next.status === 'プレビュー準備完了' &&
      next.renderedSize?.width === 5 &&
      next.renderedSize?.height === 4 &&
      next.processedPreview?.naturalWidth === 5 &&
      next.processedPreview?.naturalHeight === 4
    ) {
      return next
    }
    throw new Error(`Rounded preview is not ready with a real 5 x 4 output: ${JSON.stringify(next)}`)
  }, 'the real 5 x 4 rounded preview')

  await assertFitComparison(cdp, sessionId, 4 / 3)
  await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
  await assertFitComparison(cdp, sessionId, 4 / 3)
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  assertProcessedPreviewAligned(layout, 'rounded 5 x 4')
  const preview = layout.processedPreview
  const comparison = layout.comparisonViewport
  assert(preview && comparison, `Rounded preview comparison geometry is missing: ${JSON.stringify(layout)}`)
  const naturalRatio = preview.naturalWidth / preview.naturalHeight
  const comparisonRatio = (comparison.width - 2) / (comparison.height - 2)
  assert(Math.abs(naturalRatio - 1.25) <= 0.001, `Rounded preview natural aspect changed unexpectedly: ${JSON.stringify({ preview, naturalRatio })}`)
  assert(Math.abs(comparisonRatio - 4 / 3) <= 0.02, `Rounded preview comparison frame changed unexpectedly: ${JSON.stringify({ comparison, preview, comparisonRatio })}`)
  assert(preview.objectFit === 'fill' && Math.abs(preview.image.width - comparison.width + 2) <= 2 && Math.abs(preview.image.height - comparison.height + 2) <= 2, `Rounded preview result does not fill the aligned comparison frame: ${JSON.stringify({ comparison, preview, naturalRatio, comparisonRatio })}`)
  assert(preview.backgroundColor !== 'rgba(0, 0, 0, 0)' && preview.backgroundImage !== 'none', `Rounded preview comparison frame has no opaque checker background: ${JSON.stringify(preview)}`)

  const sourceUrl = await evaluate(cdp, sessionId, "document.querySelector('.stage-image')?.src ?? ''")
  await activateComparisonModeWithMouse(cdp, sessionId, 'original')
  const original = await readComparisonState(cdp, sessionId)
  assert(original.comparisonMode === 'original' && original.resultLayer?.visibility === 'hidden' && original.source?.visible && original.crop?.visible && original.processedInCropCount === 0, `Rounded preview original comparison is not isolated from the crop editor: ${JSON.stringify(original)}`)
  await activateComparisonModeWithMouse(cdp, sessionId, 'compare')
  const restored = await readComparisonState(cdp, sessionId)
  assert(restored.comparisonMode === 'compare' && restored.resultImage?.visible && restored.source?.visible && restored.crop?.visible, `Rounded preview comparison did not restore the result mode: ${JSON.stringify(restored)}`)
  assert(restored.resultImage?.dataKind === 'quick' && (await evaluate(cdp, sessionId, "document.querySelector('.stage-image')?.src ?? ''")) === sourceUrl, `Rounded preview mode switch changed the source identity: ${JSON.stringify({ restored, sourceUrl })}`)

  return {
    comparisonRatio,
    naturalRatio,
    output: layout.renderedSize,
    original,
    restored,
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
    const viewport = document.querySelector('.comparison-viewport')
    if (!(source instanceof HTMLImageElement) || !(preview instanceof HTMLImageElement) || !(viewport instanceof HTMLElement)) {
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
    const viewportRect = viewport.getBoundingClientRect()
    const transparentPixelOffset = ((canvas.width - 1) * 4)
    const opaqueRedPixelOffset = 0
    return {
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
      viewportRect: { bottom: viewportRect.bottom, left: viewportRect.left, right: viewportRect.right, top: viewportRect.top },
    }
  })()`)
  assert(evidence.transparentPixel.alpha === 0, `The transparency fixture did not retain a transparent right-half output pixel: ${JSON.stringify(evidence)}`)
  assert(evidence.opaqueRedPixel.alpha === 255 && evidence.opaqueRedPixel.red === 230 && evidence.opaqueRedPixel.green === 57 && evidence.opaqueRedPixel.blue === 70, `The transparency fixture did not retain its opaque red left-half output pixel: ${JSON.stringify(evidence)}`)
  assert(evidence.natural.width === 8 && evidence.natural.height === 8, `The transparent preview natural size was unexpected: ${JSON.stringify(evidence)}`)
  assert(Math.abs(evidence.previewRect.left - evidence.viewportRect.left) <= 1 && Math.abs(evidence.previewRect.right - evidence.viewportRect.right) <= 1 && Math.abs(evidence.previewRect.top - evidence.viewportRect.top) <= 1 && Math.abs(evidence.previewRect.bottom - evidence.viewportRect.bottom) <= 1, `The transparent processed preview escaped the comparison viewport: ${JSON.stringify(evidence)}`)

  const layerStyles = await evaluate(cdp, sessionId, `(() => {
    const read = (selector) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) return null
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundSize: style.backgroundSize,
      }
    }
    return { original: read('.comparison-original-layer'), result: read('.comparison-result-layer') }
  })()`)
  assert(layerStyles.original && layerStyles.result, `The transparent comparison layers are missing: ${JSON.stringify(layerStyles)}`)
  assert(layerStyles.original.backgroundColor !== 'rgba(0, 0, 0, 0)' && layerStyles.original.backgroundImage !== 'none', `The original comparison layer has no opaque checkerboard: ${JSON.stringify(layerStyles)}`)
  assert(layerStyles.result.backgroundColor !== 'rgba(0, 0, 0, 0)' && layerStyles.result.backgroundImage !== 'none', `The result comparison layer has no opaque checkerboard: ${JSON.stringify(layerStyles)}`)
  assert(JSON.stringify(layerStyles.original) === JSON.stringify(layerStyles.result), `The comparison layers do not share the same opaque checkerboard: ${JSON.stringify(layerStyles)}`)

  const checkerColors = [
    [238, 241, 238],
    [203, 210, 207],
  ]
  const sampleFractions = [
    [0.68, 0.42],
    [0.76, 0.58],
    [0.84, 0.74],
    [0.92, 0.46],
  ]
  const isCheckerPixel = (pixel) => checkerColors.some(([red, green, blue]) => (
    Math.abs(pixel.red - red) <= 28 && Math.abs(pixel.green - green) <= 28 && Math.abs(pixel.blue - blue) <= 28
  ))
  const captureComparisonSamples = async (mode, split) => {
    await activateComparisonModeWithMouse(cdp, sessionId, mode)
    if (split !== undefined) await setControlValue(cdp, sessionId, '#comparison-split', split)
    await waitForDom(cdp, sessionId, `[...document.querySelectorAll('.comparison-mode-button')].find((button) => button.getAttribute('aria-pressed') === 'true')?.getAttribute('data-comparison-mode') === ${JSON.stringify(mode)}`, `${mode} transparency comparison mode`)
    await evaluate(cdp, sessionId, `document.querySelector('.comparison-section')?.scrollIntoView({ block: 'center', inline: 'nearest' })`)
    const state = await readComparisonState(cdp, sessionId)
    assert(state.viewport?.visible, `${mode} transparency comparison viewport is not visible: ${JSON.stringify(state)}`)
    const pixels = await captureScreenshotSamples(cdp, sessionId, sampleFractions.map(([x, y]) => [
      state.viewport.left + state.viewport.width * x,
      state.viewport.top + state.viewport.height * y,
    ]))
    return { mode, pixels, state }
  }

  await setControlValue(cdp, sessionId, '#output-format', 'image/jpeg')
  const jpegReady = await waitFor(async () => {
    const state = await readPr8State(cdp, sessionId)
    if (state.outputMime === 'image/jpeg' && state.status === 'プレビュー準備完了' && state.previewNaturalWidth === 8 && state.previewNaturalHeight === 8 && state.previewUrl.startsWith('blob:')) return state
    throw new Error(`The JPEG transparency preview is not ready: ${JSON.stringify(state)}`)
  }, 'the JPEG transparency preview', PR8_ASSERTION_TIMEOUT_MS)
  const jpegResult = await captureComparisonSamples('result')
  const jpegCompare = await captureComparisonSamples('compare', 100)
  assert(jpegResult.pixels.some((pixel) => !isCheckerPixel(pixel)), `The JPEG result samples unexpectedly look like the checkerboard: ${JSON.stringify({ jpegReady, jpegResult })}`)
  assert(jpegCompare.pixels.every(isCheckerPixel), `Transparent original pixels exposed the encoded result instead of the original layer checkerboard: ${JSON.stringify({ jpegCompare, jpegResult, layerStyles })}`)
  assert(jpegCompare.pixels.some((pixel, index) => JSON.stringify(pixel) !== JSON.stringify(jpegResult.pixels[index])), `Transparent original pixels matched the encoded result through the comparison layer: ${JSON.stringify({ jpegCompare, jpegResult })}`)

  await setControlValue(cdp, sessionId, '#output-format', 'image/png')
  const pngReady = await waitFor(async () => {
    const state = await readPr8State(cdp, sessionId)
    if (state.outputMime === 'image/png' && state.status === 'プレビュー準備完了' && state.previewNaturalWidth === 8 && state.previewNaturalHeight === 8 && state.previewUrl.startsWith('blob:')) return state
    throw new Error(`The PNG transparency preview is not ready after JPEG comparison: ${JSON.stringify(state)}`)
  }, 'the PNG transparency preview after layer comparison', PR8_ASSERTION_TIMEOUT_MS)
  const pngResult = await captureComparisonSamples('result')
  assert(pngResult.pixels.every(isCheckerPixel), `Transparent result pixels did not use the result layer checkerboard: ${JSON.stringify({ layerStyles, pngReady, pngResult })}`)
  assertComparisonRectsAligned(pngResult.state, 'transparent PNG comparison alignment')
  return { evidence, jpegCompare, jpegResult, layerStyles, pngReady, pngResult }
}

async function runScenario({ allowedPaths, basePath, corruptFixturePath, cropDragFixturePath, downloadDirectory, fixturePath, layoutFixtures, pageUrl, origin, requestLog, cdp, sessionId, targetId, roundedPreviewFixturePath, sourceFamilies, sourceOrientation, transparencyFixturePath, unsupportedFixturePath }) {
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
  const corruptionRegression = await runCorruptReplacementRegression({ cdp, corruptFixturePath, downloadDirectory, sessionId, unsupportedFixturePath })
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
  const comparisonPersistenceRegression = await runComparisonPersistenceRegression({ cdp, sessionId })

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
  assert(outputDimensions.width === 16 && outputDimensions.height === 32, `Downloaded JPEG dimensions were ${outputDimensions.width}x${outputDimensions.height}, expected 16x32 after the comparison cleanup reset.`)
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

  const fullOutputComparisonRegression = await runFullOutputComparisonRegression({
    cdp,
    downloadDirectory,
    cropDragFixturePath,
    fixturePath,
    sessionId,
  })

  const pr8AdditionalFindingsRegression = await runPr8AdditionalFindingsRegression({
    cdp,
    corruptFixturePath,
    cropDragFixturePath,
    downloadDirectory,
    fixturePath,
    sessionId,
    unsupportedFixturePath,
  })

  const cropSurfaceSizing = await runCropSurfaceSizingRegression({ cdp, layoutFixtures, sessionId })
  const roundedPreviewRegression = await runRoundedPreviewRegression({ cdp, fixturePath: roundedPreviewFixturePath, sessionId })
  const transparencyComparisonRegression = await runTransparencyComparisonRegression({ cdp, fixturePath: transparencyFixturePath, sessionId })
  diagnostics.assertClean()

  const observedRequests = network.getObservedRequests()
  assertNetworkIsLocal(observedRequests, origin, { allowedPaths, requestLog })
  const targetInfo = await getTargetInfo(cdp, targetId)
  return {
    browserTarget: targetInfo ? { targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url } : undefined,
    aspectAndGuideRegression,
    comparisonPersistenceRegression,
    fullOutputComparisonRegression,
    corruptionRegression,
    roundedPreviewRegression,
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
    pr8AdditionalFindingsRegression,
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
  const corruptFixturePath = join(temporaryRoot, 'e2e-corrupt-replacement.jpg')
  const unsupportedFixturePath = join(temporaryRoot, 'e2e-unsupported-replacement.gif')
  const cropDragFixturePath = join(temporaryRoot, 'e2e-crop-drag.png')
  const roundedPreviewFixturePath = join(temporaryRoot, 'e2e-rounded-preview.png')
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
    await writeFile(corruptFixturePath, Buffer.from('not a valid JPEG fixture'))
    await writeFile(unsupportedFixturePath, Buffer.from('not a supported image fixture'))

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

    if (process.env.E2E_ONLY === 'preview-ux') {
      report = await runPersistentComparisonRedRegression({
        cdp,
        fixturePath,
        pageUrl: staticServer.pageUrl,
        sessionId: pageSessionId,
      })
      console.log(JSON.stringify({ basePath, previewUxRegression: report }, null, 2))
      console.log('Chromium E2E preview UX regression: PASS')
      return report
    }

    report = await runScenario({
      allowedPaths,
      basePath,
      corruptFixturePath,
      cropDragFixturePath,
      cdp,
      downloadDirectory,
      fixturePath,
      layoutFixtures,
      origin: staticServer.origin,
      pageUrl: staticServer.pageUrl,
      requestLog: staticServer.requestLog,
      roundedPreviewFixturePath,
      sessionId: pageSessionId,
      sourceFamilies,
      sourceOrientation,
      transparencyFixturePath,
      targetId: pageTargetId,
      unsupportedFixturePath,
    })
    report.processorStartupFailure = await runProcessorStartupFailureRegression({
      allowedPaths,
      cdp,
      fixturePath,
      origin: staticServer.origin,
      pageUrl: staticServer.pageUrl,
      requestLog: staticServer.requestLog,
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
