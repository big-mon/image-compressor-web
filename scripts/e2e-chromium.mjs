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
      requests: [],
      arm(preview) {
        this.preview = preview
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
        gate.requests.push({preview: message.output.preview, time: performance.now(), quality: message.output.quality})
        if (gate.armed && !gate.payload && (gate.preview === undefined || message.output.preview === gate.preview)) {
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
      renderedSize: document.querySelector('.workspace')?.dataset.quickWidth + ' × ' + document.querySelector('.workspace')?.dataset.quickHeight + ' px',
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
      previewLabel: describe('.stage-preview-label'),
      previewLabelText: document.querySelector('.stage-preview-label')?.textContent?.trim() ?? '',
      processedPreview: describeProcessedPreview(document.querySelector('.processed-preview')),
      processedPreviewCount: document.querySelectorAll('.processed-preview').length,
      renderedSize: document.querySelector('.workspace')?.dataset.quickWidth + ' × ' + document.querySelector('.workspace')?.dataset.quickHeight + ' px',
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


function assertVisibleRect(rect, description) {
  assert(rect?.visible && rect.width > 0 && rect.height > 0, `${description} is not visible: ${JSON.stringify(rect)}`)
}

function assertInsideViewport(rect, viewport, description) {
  assertVisibleRect(rect, description)
  assert(rect.top >= -1 && rect.bottom <= viewport.height + 1, `${description} is outside the initial viewport: ${JSON.stringify({ rect, viewport })}`)
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
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.getAttribute('aria-label') || candidate.textContent)?.includes(${quotedText}))
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

    await clickButton(cdp, sessionId, 'リセット')
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

async function runCancelledExportSelectionRegression({ candidateFixturePath, cdp, downloadDirectory, expectedSourceDimensions, fixturePath, sessionId }) {
  const restored = await restoreReadySource(cdp, sessionId, fixturePath, 'cancelled export baseline', '16 × 32 px')
  const baseline = restored.ready
  const filesBefore = (await readdir(downloadDirectory)).sort()
  try {
    await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.arm()')
    await clickButton(cdp, sessionId, '保存 .')
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
    await clickButton(cdp, sessionId, '保存 .')
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


async function waitForFullOutput(cdp, sessionId) {
  await waitForDom(cdp, sessionId, `document.querySelector('.processed-preview')?.dataset.previewKind === 'full' && document.querySelector('.processed-preview')?.complete && !document.querySelector('.download-button')?.disabled`, 'current full output')
}

async function selectEditorView(cdp, sessionId, view) {
  await evaluate(cdp, sessionId, `document.querySelectorAll('.view-switch button')[${view === 'edit' ? 0 : 1}].click()`)
  await waitForDom(cdp, sessionId, `document.querySelector('.${view === 'edit' ? 'stage-area' : 'comparison-section'}')?.hidden === false`, `${view} view`)
}

async function setOutputPanel(cdp, sessionId, open) {
  if (await evaluate(cdp, sessionId, `document.querySelector('.output-toggle')?.getAttribute('aria-expanded') !== '${open}'`)) {
    const toggle = await evaluate(cdp, sessionId, `(()=>{const r=document.querySelector('.output-toggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...toggle,button:'left',clickCount:1},sessionId)
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...toggle,button:'left',clickCount:1},sessionId)
  }
  await waitForDom(cdp, sessionId, `document.querySelector('#output-panel')?.hidden === ${!open}`, 'output panel state')
}

async function assertEditorLayout(cdp, sessionId, viewport, panelOpen) {
  await setViewport(cdp, sessionId, viewport)
  await setOutputPanel(cdp, sessionId, false)
  const closedEditor = await evaluate(cdp,sessionId,`document.querySelector('.editor-column').getBoundingClientRect().toJSON()`)
  await setOutputPanel(cdp, sessionId, panelOpen)
  await selectEditorView(cdp, sessionId, 'edit')
  const layout = await evaluate(cdp, sessionId, `(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom } }
    return { root:rect('#root'), body:rect('body'), html:rect('html'), shell:rect('.editor-shell'), stage:rect('.stage-area'), surface:rect('.crop-surface'), bottom:rect('.editor-bottom'), panel:rect('#output-panel'), editor:rect('.editor-column'), header:rect('.tool-toolbar'),
      scrollHeight:document.documentElement.scrollHeight, scrollWidth:document.documentElement.scrollWidth,
      fullscreen:document.fullscreenElement !== null, headings:document.querySelectorAll('.workspace h2:not(.output-menu-title)').length,
      footer:document.querySelector('footer') !== null,
      toggle:rect('.output-toggle'), menuPosition:getComputedStyle(document.querySelector('.output-menu')).position,
      headerToggle:document.querySelector('.tool-toolbar .output-toggle') !== null,
      panelOnTop:(()=>{const p=document.querySelector('#output-panel'),r=p.getBoundingClientRect();return p.contains(document.elementFromPoint(r.x+r.width/2,r.y+20))})(),
      buttons:[...document.querySelectorAll('.tool-toolbar button,.edit-modes button,.output-toggle')].map(b=>({height:b.getBoundingClientRect().height,width:b.getBoundingClientRect().width})),
    }
  })()`)
  const inside = r => r.x >= -1 && r.y >= -1 && r.right <= viewport.width + 1 && r.bottom <= viewport.height + 1
  assert(layout.shell.height === viewport.height && !layout.fullscreen, `Editor must own the website viewport: ${JSON.stringify(layout)}`)
  assert(layout.scrollWidth <= viewport.width && layout.scrollHeight <= viewport.height + 1, `Editor overflow: ${JSON.stringify(layout)}`)
  assert(!layout.footer && layout.headings === 0, 'Retired headings or footer remain in the editor.')
  assert(inside(layout.header) && inside(layout.bottom) && inside(layout.stage), `Primary controls escaped viewport: ${JSON.stringify(layout)}`)
  assert(layout.surface.width > 0 && layout.surface.height >= 80 && inside(layout.surface), `Image does not fit: ${JSON.stringify(layout)}`)
  assert(layout.surface.bottom <= layout.bottom.y && layout.stage.bottom <= layout.bottom.y + 1, 'Image overlaps the bottom controls.')
  assert(layout.buttons.every(b => b.height >= 44 && b.width >= 44), 'Primary buttons must have 44px tap targets.')
  assert(!layout.headerToggle && layout.menuPosition==='fixed' && inside(layout.toggle), 'Output menu must be fixed outside the header.')
  assert(viewport.width-layout.toggle.right <= 17 && viewport.height-layout.toggle.bottom <= 17,'Menu is not at the bottom right.')
  assert(layout.editor.width===closedEditor.width && layout.editor.height===closedEditor.height,'Opening settings resized the image area.')
  if (panelOpen) {
    assert(inside(layout.panel) && layout.panel.height > 0 && layout.panelOnTop, 'Output panel must be visible above the image.')
    assert(layout.panel.x < layout.editor.right && layout.panel.y < layout.editor.bottom, 'Output panel must overlap the editor.')
    assert(layout.panel.bottom < layout.toggle.y, 'Menu toggle must remain reachable below the panel.')
    const scroll = await evaluate(cdp,sessionId,`(()=>{const p=document.querySelector('#output-panel');p.scrollTop=p.scrollHeight;const r=p.querySelector('#resize-height').getBoundingClientRect(),b=p.getBoundingClientRect();const visible=r.top>=b.top&&r.bottom<=b.bottom;p.scrollTop=0;return visible})()`)
    assert(scroll,'Output settings at the bottom are not reachable.')
  }
  return layout
}

async function assertStraightenedStage(cdp, sessionId) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const surface = document.querySelector('.crop-surface').getBoundingClientRect()
    const image = document.querySelector('.stage-image')
    const style = getComputedStyle(image), matrix = new DOMMatrix(style.transform)
    const w = parseFloat(style.width), h = parseFloat(style.height)
    const origin = {x:surface.width/2+w/2,y:surface.height/2+h/2}
    const corners = [[0,0],[w,0],[0,h],[w,h]].map(([x,y]) => {
      const p = matrix.transformPoint({x:x-w/2,y:y-h/2})
      return {x:p.x+origin.x,y:p.y+origin.y}
    })
    const crop = document.querySelector('.crop-rectangle').getBoundingClientRect()
    const inverse = matrix.inverse()
    const cropCorners = [[crop.left,crop.top],[crop.right,crop.top],[crop.left,crop.bottom],[crop.right,crop.bottom]].map(([x,y]) => {
      const p = inverse.transformPoint({x:x-surface.left-origin.x,y:y-surface.top-origin.y})
      return {x:p.x+w/2,y:p.y+h/2}
    })
    return {corners,cropCorners,width:surface.width,height:surface.height,imageWidth:w,imageHeight:h}
  })()`)
  assert(result.corners.every(p => p.x >= -0.1 && p.y >= -0.1 && p.x <= result.width+0.1 && p.y <= result.height+0.1), 'Rotated image is clipped by the stage: '+JSON.stringify(result))
  assert(result.cropCorners.every(p => p.x >= -0.1 && p.y >= -0.1 && p.x <= result.imageWidth+0.1 && p.y <= result.imageHeight+0.1), 'Crop extends beyond the actual image: '+JSON.stringify(result))
}

async function assertTransformedPixels(cdp, sessionId, { rotation, straighten, flipHorizontal, flipVertical }) {
  // Independent Canvas oracle: construct the transformed full frame, then crop/resize it.
  const result = await evaluate(cdp, sessionId, `(async () => {
    const source = document.querySelector('.stage-image'); await source.decode()
    const actual = document.querySelector('.processed-preview'); await actual.decode()
    const iw = ${rotation} % 180 ? source.naturalHeight : source.naturalWidth
    const ih = ${rotation} % 180 ? source.naturalWidth : source.naturalHeight
    const a = ${straighten} * Math.PI / 180
    const w = Math.ceil(iw*Math.cos(a)+ih*Math.abs(Math.sin(a)))
    const h = Math.ceil(ih*Math.cos(a)+iw*Math.abs(Math.sin(a)))
    const frame = document.createElement('canvas'); frame.width=w; frame.height=h
    const ctx=frame.getContext('2d'); ctx.translate(w/2,h/2); ctx.scale(${flipHorizontal ? -1 : 1},${flipVertical ? -1 : 1}); ctx.rotate((${rotation}+${straighten})*Math.PI/180); ctx.drawImage(source,-source.naturalWidth/2,-source.naturalHeight/2)
    const crop=document.querySelector('.crop-rectangle').style
    const values=[parseFloat(crop.left)*w/100,parseFloat(crop.top)*h/100,parseFloat(crop.width)*w/100,parseFloat(crop.height)*h/100]
    const expected=document.createElement('canvas'); expected.width=actual.naturalWidth; expected.height=actual.naturalHeight
    const ec=expected.getContext('2d'); ec.imageSmoothingQuality='high'; ec.drawImage(frame,...values,0,0,expected.width,expected.height)
    const output=document.createElement('canvas'); output.width=expected.width; output.height=expected.height
    const oc=output.getContext('2d'); oc.drawImage(actual,0,0)
    const e=ec.getImageData(0,0,expected.width,expected.height).data, o=oc.getImageData(0,0,expected.width,expected.height).data
    let sum=0, max=0, transparent=0
    for(let i=0;i<e.length;i++) { const d=Math.abs(e[i]-o[i]); sum+=d; max=Math.max(max,d); if(i%4===3 && o[i]===0) transparent++ }
    return {mean:sum/e.length,max,transparent,width:output.width,height:output.height,transform:source.style.transform}
  })()`)
  assert(result.mean < 2, `Worker pixels differ from transform/crop/resize oracle: ${JSON.stringify(result)}`)
  return result
}

async function runScenario({ allowedPaths, basePath, cdp, sessionId, fixturePath, cropDragFixturePath, corruptFixturePath, unsupportedFixturePath, downloadDirectory, pageUrl, origin, requestLog, targetId, sourceFamilies, sourceOrientation }) {
  const diagnostics = new BrowserDiagnostics(cdp, sessionId)
  const network = new NetworkRecorder(cdp, sessionId)
  for (const domain of ['Network','Runtime','Log','Page']) await cdp.send(`${domain}.enable`, {}, sessionId)
  await setViewport(cdp, sessionId, DESKTOP_VIEWPORT)
  await cdp.send('Page.navigate', {url:pageUrl}, sessionId)
  await waitForDom(cdp, sessionId, `document.querySelector('#image-input') !== null`, 'built app')
  await evaluate(cdp, sessionId, `(() => {
    window.__e2eBlobs = new Map(); window.__e2eRevoked = []
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL
    URL.createObjectURL = blob => { const url=create(blob); window.__e2eBlobs.set(url,blob); return url }
    URL.revokeObjectURL = url => { window.__e2eBlobs.delete(url); window.__e2eRevoked.push(url); revoke(url) }
  })()`)
  await assertPublicMetadataAndFooter(cdp, sessionId, basePath)
  await assertEmptyFirstView(cdp, sessionId, DESKTOP_VIEWPORT, 'desktop')
  await setViewport(cdp, sessionId, MOBILE_VIEWPORT)
  await assertEmptyFirstView(cdp, sessionId, MOBILE_VIEWPORT, 'mobile')
  await installWorkerProcessGate(cdp, sessionId)
  await dispatchFileDrop(cdp, sessionId, '.drop-zone', fixturePath)
  await waitForDom(cdp, sessionId, `document.querySelector('.processed-preview')?.dataset.previewKind === 'quick' && !document.querySelector('.download-button')?.disabled`, 'initial quick preview')
  await delay(800)
  assert(await evaluate(cdp, sessionId, `window.__e2eWorkerProcessGate.requests.every(r => r.preview)`), 'Closed output panel started an automatic full encode.')
  assert(await evaluate(cdp, sessionId, `document.querySelector('.output-toggle').getAttribute('aria-expanded') === 'false'`), 'Output panel must start collapsed.')
  await setOutputPanel(cdp, sessionId, true)
  await waitForFullOutput(cdp, sessionId)
  const requestCount = await evaluate(cdp, sessionId, 'window.__e2eWorkerProcessGate.requests.length')
  await setControlValue(cdp, sessionId, '#quality', '0.81')
  await waitForDom(cdp, sessionId, `document.querySelector('.processed-preview')?.dataset.previewKind === 'quick' && !document.querySelector('.download-button')?.disabled`, 'quick preview before cancelling the scheduled full encode')
  await setOutputPanel(cdp, sessionId, false)
  await waitForDom(cdp, sessionId, `document.querySelector('.processed-preview')?.dataset.previewKind === 'quick' && !document.querySelector('.download-button')?.disabled`, 'quick preview after closing output settings')
  await delay(800)
  assert(await evaluate(cdp, sessionId, `window.__e2eWorkerProcessGate.requests.slice(${requestCount}).every(r => r.preview)`), 'Closing the panel did not cancel the pending automatic full encode.')
  await clickButton(cdp, sessionId, '保存 .')
  await waitForFullOutput(cdp, sessionId)
  await waitForDownloadedFile(downloadDirectory, 'e2e-metadata-fixture-edited.jpg')
  assert(await evaluate(cdp, sessionId, `window.__e2eWorkerProcessGate.requests.slice(${requestCount}).filter(r => !r.preview).length === 1`), 'Explicit save with a closed panel must encode exactly once.')
  assert(await evaluate(cdp, sessionId, `document.querySelector('.metrics-card .metric-line strong').textContent === '16 × 32 px'`), 'EXIF orientation was not normalized.')
  assert(await evaluate(cdp, sessionId, `document.querySelector('.output-toggle').getAttribute('aria-expanded') === 'false'`), 'Output panel must start collapsed.')
  const layouts = []
  for (const viewport of [DESKTOP_VIEWPORT,MOBILE_VIEWPORT,{...DESKTOP_VIEWPORT,width:800,height:600},{...MOBILE_VIEWPORT,width:667,height:375}]) {
    for(const open of [false,true]) {
      layouts.push(await assertEditorLayout(cdp,sessionId,viewport,open))
      await captureScreenshot(cdp,sessionId,`editor-${viewport.width}-${viewport.height}-${open?'output':'crop'}.png`)
    }
  }
  await setViewport(cdp,sessionId,DESKTOP_VIEWPORT)
  await setOutputPanel(cdp,sessionId,true)
  await evaluate(cdp,sessionId, `document.querySelector('#output-format').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await waitForDom(cdp,sessionId,`document.querySelector('#output-panel').hidden && document.activeElement === document.querySelector('.output-toggle')`, 'Escape closes panel and restores focus')
  await setOutputPanel(cdp,sessionId,true)

  // PNG oracle fixture with asymmetric colored cells (large enough for reduced preview).
  const png = await evaluate(cdp,sessionId,`(() => {const c=document.createElement('canvas');c.width=1000;c.height=600;const x=c.getContext('2d');for(let y=0;y<600;y+=20) for(let z=0;z<1000;z+=20){x.fillStyle='rgb('+((z*7+y)%256)+','+((y*3+z)%256)+','+((z+y*5)%256)+')';x.fillRect(z,y,20,20)}return c.toDataURL().split(',')[1]})()`)
  await writeFile(cropDragFixturePath,Buffer.from(png,'base64'))
  await setFileInput(cdp,sessionId,cropDragFixturePath)
  await waitForFullOutput(cdp,sessionId)
  await setControlValue(cdp,sessionId,'#output-format','image/png')
  await waitForFullOutput(cdp,sessionId)
  assert(await evaluate(cdp,sessionId,`document.querySelector('#quality') === null`), 'PNG must not expose lossy quality.')
  await clickButton(cdp,sessionId,'傾き・反転')
  await clickButton(cdp,sessionId,'右へ90°')
  await clickButton(cdp,sessionId,'左右反転')
  await setControlValue(cdp,sessionId,'#straighten','17.3')
  await waitForFullOutput(cdp,sessionId)
  const pixels=[]
  pixels.push(await assertTransformedPixels(cdp,sessionId,{rotation:90,straighten:17.3,flipHorizontal:true,flipVertical:false}))
  assert(pixels[0].transparent===0,'Straightening introduced transparent corners.')
  await clickButton(cdp,sessionId,'上下反転')
  await setControlValue(cdp,sessionId,'#straighten','-45')
  await waitForFullOutput(cdp,sessionId)
  pixels.push(await assertTransformedPixels(cdp,sessionId,{rotation:90,straighten:-45,flipHorizontal:true,flipVertical:true}))
  assert(pixels[1].transparent===0,'Extreme straightening introduced transparent corners.')
  await captureScreenshot(cdp,sessionId,'editor-straighten.png')

  for (const viewport of [DESKTOP_VIEWPORT, MOBILE_VIEWPORT, {...MOBILE_VIEWPORT,width:667,height:375}]) {
    await setViewport(cdp,sessionId,viewport)
    const controls = await evaluate(cdp,sessionId,`(()=>{const slider=document.querySelector('.straighten-control').getBoundingClientRect(),icons=document.querySelector('.transform-buttons').getBoundingClientRect();return {sliderBottom:slider.bottom,iconsTop:icons.top,iconsBottom:icons.bottom,buttons:[...document.querySelectorAll('.transform-buttons button')].map(b=>({label:b.getAttribute('aria-label'),text:b.textContent.trim(),w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height})),cropVisible:document.querySelector('.crop-rectangle').getBoundingClientRect().height>0}})()`)
    assert(controls.iconsTop>=controls.sliderBottom && controls.iconsBottom<=viewport.height && controls.cropVisible && controls.buttons.every(b=>b.label && !b.text && b.w>=44 && b.h>=44),'Transform controls must be separate rows with accessible icons: '+JSON.stringify(controls))
    await assertStraightenedStage(cdp,sessionId)
    await captureScreenshot(cdp,sessionId,`icon-controls-${viewport.width}.png`)
  }
  await setViewport(cdp,sessionId,DESKTOP_VIEWPORT)
  await clickButton(cdp,sessionId,'クロップ')
  assert(await evaluate(cdp,sessionId,`document.querySelector('select#aspect-ratio')===null && document.querySelectorAll('.aspect-preset').length===9`),'Aspect ratios must be preset buttons.')
  await waitForDom(cdp,sessionId,`document.querySelector('.crop-controls').hidden===false`, 'crop preset controls visible')
  await evaluate(cdp,sessionId,`document.querySelector('[data-aspect-ratio="original"]').click()`)
  await waitForDom(cdp,sessionId,`(() => {
    const icon = document.querySelector('[data-aspect-ratio="original"] .aspect-icon').getBoundingClientRect()
    const crop = [...document.querySelectorAll('.crop-coordinates input')].map(input => Number(input.value))
    return Math.abs(icon.width / icon.height - 0.6) < 0.01 && Math.abs(icon.width / icon.height - crop[2] / crop[3]) < 0.01
  })()`, 'original preset icon matches the rotated crop ratio')
  await evaluate(cdp,sessionId,`document.querySelector('[data-aspect-ratio="1:1"]').focus()`)
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13},sessionId)
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13},sessionId)
  await waitForDom(cdp,sessionId,`document.querySelector('[data-aspect-ratio="1:1"]').getAttribute('aria-pressed')==='true' && document.querySelectorAll('.aspect-preset[aria-pressed="true"]').length===1 && document.querySelector('.crop-coordinates label:nth-child(3) input').value===document.querySelector('.crop-coordinates label:nth-child(4) input').value`, 'keyboard selection applies the square preset')
  await evaluate(cdp,sessionId,`document.querySelector('[data-aspect-ratio="free"]').click()`)
  await openDetails(cdp,sessionId,'.advanced-controls')
  for(const [n,value] of [[2,100],[3,100],[0,500],[1,500]]) await setControlValue(cdp,sessionId,`.crop-coordinates label:nth-child(${n+1}) input`,value)
  await setControlValue(cdp,sessionId,'#resize-width','200')
  await waitForFullOutput(cdp,sessionId)
  pixels.push(await assertTransformedPixels(cdp,sessionId,{rotation:90,straighten:-45,flipHorizontal:true,flipVertical:true}))
  // Crop remains keyboard and pointer operable in the straightening mode.
  await clickButton(cdp,sessionId,'傾き・反転')
  await evaluate(cdp,sessionId,`document.querySelector('.advanced-controls').open=false`)
  const keyboardBefore = await evaluate(cdp,sessionId,`Number(document.querySelector('.crop-coordinates input').value)`)
  await evaluate(cdp,sessionId,`document.querySelector('.crop-rectangle').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
  await waitForDom(cdp,sessionId,`Number(document.querySelector('.crop-coordinates input').value)===${keyboardBefore + 1}`,'keyboard crop move')
  const cropBefore=await evaluate(cdp,sessionId,`document.querySelector('.crop-coordinates input').value`)
  const r=await evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('.crop-rectangle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1},sessionId)
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+10,y:r.y+10,button:'left',buttons:1},sessionId)
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x+10,y:r.y+10,button:'left',clickCount:1},sessionId)
  assert(await evaluate(cdp,sessionId,`document.querySelector('.crop-coordinates input').value !== '${cropBefore}'`),'Pointer crop move did not update geometry.')
  await waitForFullOutput(cdp,sessionId)

  const beforeResize=await evaluate(cdp,sessionId,`document.querySelector('.crop-coordinates label:nth-child(3) input').value`)
  const handle=await evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('.crop-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...handle,button:'left',clickCount:1},sessionId)
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x-10,y:handle.y-10,button:'left',buttons:1},sessionId)
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x-10,y:handle.y-10,button:'left',clickCount:1},sessionId)
  assert(await evaluate(cdp,sessionId,`Number(document.querySelector('.crop-coordinates label:nth-child(3) input').value)<${beforeResize}`),'Crop resize must work in straightening mode.')
  const edgeStart = await evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('.crop-rectangle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...edgeStart,button:'left',clickCount:1},sessionId)
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:edgeStart.x+1000,y:edgeStart.y,button:'left',buttons:1},sessionId)
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:edgeStart.x+1000,y:edgeStart.y,button:'left',clickCount:1},sessionId)
  assert(await evaluate(cdp,sessionId,`(()=>{const c=document.querySelector('.crop-rectangle').style;return (parseFloat(c.left)+parseFloat(c.width))*1132/100>(1132+600)/2})()`),'Crop cannot reach the image beyond the old fixed frame.')
  await assertStraightenedStage(cdp,sessionId)
  await waitForFullOutput(cdp,sessionId)
  const edgePixels = await assertTransformedPixels(cdp,sessionId,{rotation:90,straighten:-45,flipHorizontal:true,flipVertical:true})
  assert(edgePixels.transparent===0,'Edge crop includes empty space.')
  await captureScreenshot(cdp,sessionId,'editor-edge-crop.png')
  await selectEditorView(cdp,sessionId,'compare')
  assert(await evaluate(cdp,sessionId,`!document.querySelector('.comparison-controls, .comparison-inspection-controls, [data-comparison-mode]')`),'Obsolete comparison controls remain.')
  const comparisonBounds = await evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('#comparison-split').getBoundingClientRect();return {x:r.x,y:r.y+r.height/2,width:r.width}})()`)
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:comparisonBounds.x+comparisonBounds.width*0.7,y:comparisonBounds.y,button:'left',clickCount:1},sessionId)
  await waitForDom(cdp,sessionId,`document.querySelector('#comparison-split').value==='70'`,'comparison image click')
  for (const [fraction, expected] of [[1.1,100],[-0.1,0],[0.35,35]]) {
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:comparisonBounds.x+comparisonBounds.width*fraction,y:comparisonBounds.y,button:'left',buttons:1},sessionId)
    await waitForDom(cdp,sessionId,`document.querySelector('#comparison-split').value==='${expected}'`,'comparison drag and edge clamping')
  }
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:comparisonBounds.x+comparisonBounds.width*0.35,y:comparisonBounds.y,button:'left',clickCount:1},sessionId)
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:comparisonBounds.x+comparisonBounds.width*0.6,y:comparisonBounds.y},sessionId)
  assert(await evaluate(cdp,sessionId,`document.querySelector('#comparison-split').value==='35'`),'Comparison kept dragging after release.')
  const comparison=await evaluate(cdp,sessionId,`(()=>{const v=document.querySelector('.comparison-viewport').getBoundingClientRect(),r=document.querySelector('.processed-preview').getBoundingClientRect();return {width:v.width,height:v.height,aligned:Math.abs(v.width-r.width)<1&&Math.abs(v.height-r.height)<1,clip:document.querySelector('.comparison-original-layer').style.clipPath,hidden:document.querySelector('.stage-area').hidden}})()`)
  assert(comparison.aligned && comparison.width>0 && comparison.height>0 && comparison.hidden && comparison.clip.includes('65%'),'Single-stage comparison is misaligned.')
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},sessionId)
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},sessionId)
  await waitForDom(cdp,sessionId,`document.querySelector('#comparison-split').value==='36'`,'keyboard comparison boundary')
  await captureScreenshot(cdp,sessionId,'editor-comparison.png')
  await setOutputPanel(cdp,sessionId,false)
  for(const viewport of [MOBILE_VIEWPORT,{...MOBILE_VIEWPORT,width:667,height:375}]) {
    await setViewport(cdp,sessionId,viewport)
    const fit=await evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('.comparison-viewport').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}})()`)
    assert(fit.width>0 && fit.height>=60 && fit.bottom<=viewport.height && fit.right<=viewport.width, 'Comparison image must fit small windows: '+JSON.stringify(fit))
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true},sessionId)
    const touch = {x:fit.x+fit.width*0.25,y:fit.y+fit.height/2}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]},sessionId)
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...touch,x:fit.x+fit.width*0.65}]},sessionId)
    await waitForDom(cdp,sessionId,`document.querySelector('#comparison-split').value==='65'`,'touch comparison drag')
    await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]},sessionId)
    assert(await evaluate(cdp,sessionId,`document.querySelector('#comparison-split').value==='65'`),'Cancel changed the comparison boundary.')
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false},sessionId)
    await captureScreenshot(cdp,sessionId,`editor-compare-${viewport.width}.png`)
  }
  await setViewport(cdp,sessionId,DESKTOP_VIEWPORT)
  await setControlValue(cdp,sessionId,'#composition-guide','golden')
  assert(await evaluate(cdp,sessionId,`document.querySelector('#comparison-split').value==='65'`),'Comparison boundary was not persistent.')

  await setOutputPanel(cdp,sessionId,true)
  await setControlValue(cdp,sessionId,'#output-format','image/jpeg')
  await setControlValue(cdp,sessionId,'#quality','0.57')
  await waitForFullOutput(cdp,sessionId)
  const bytes=await evaluate(cdp,sessionId,`(async()=>{const i=document.querySelector('.processed-preview');return Array.from(new Uint8Array(await window.__e2eBlobs.get(i.src).arrayBuffer()))})()`)
  const expectedBytes=Buffer.from(bytes)
  const capacity=await evaluate(cdp,sessionId,`({bytes:Number(document.querySelector('.processed-preview').dataset.outputBytes),bars:[...document.querySelectorAll('.capacity-track span')].map(e=>parseFloat(e.style.width)),reduction:document.querySelector('.reduction-line strong').textContent})`)
  assert(capacity.bytes===expectedBytes.length && Math.max(...capacity.bars)===100,'Capacity bars do not reflect the full Blob.')
  await installWorkerProcessGate(cdp,sessionId)
  await evaluate(cdp,sessionId,'window.__e2eWorkerProcessGate.arm()')
  await clickButton(cdp,sessionId,'保存 .')
  const downloadPath=await waitForDownloadedFile(downloadDirectory,'e2e-crop-drag-edited.jpg')
  assert((await readFile(downloadPath)).equals(expectedBytes),'Download did not reuse the measured Blob.')
  assert(!(await readWorkerProcessGate(cdp,sessionId)).held,'Saving an existing full result launched another encode.')
  await evaluate(cdp,sessionId,'window.__e2eWorkerProcessGate.disarm()')
  assert(Object.values(detectMetadataFamilies(expectedBytes)).every(v=>!v),'Output metadata remained.')

  // Invalid replacements retain the committed image and completed full result.
  for(const invalid of [corruptFixturePath,unsupportedFixturePath]) {
    const before=await readPr8State(cdp,sessionId)
    await setFileInput(cdp,sessionId,invalid)
    await waitForDom(cdp,sessionId,`document.querySelector('.error-message') !== null && !document.querySelector('.download-button').disabled`,'invalid replacement settles')
    const after=await readPr8State(cdp,sessionId)
    assert(after.sourceUrl===before.sourceUrl && after.previewUrl===before.previewUrl,'Invalid replacement discarded committed image/result.')
  }

  // Hold old preview or full output; a newer intent must win even after release.
  const races=[]
  for(const preview of [true,false]) {
    await evaluate(cdp,sessionId,`window.__e2eWorkerProcessGate.arm(${preview})`)
    await setControlValue(cdp,sessionId,'#quality',preview?'0.61':'0.62')
    await waitForDom(cdp,sessionId,`window.__e2eWorkerProcessGate.held`,'held old render')
    await setControlValue(cdp,sessionId,'#quality',preview?'0.71':'0.72')
    await waitForFullOutput(cdp,sessionId)
    const current=await readPr8State(cdp,sessionId)
    await evaluate(cdp,sessionId,'window.__e2eWorkerProcessGate.release()')
    await delay(250)
    const after=await readPr8State(cdp,sessionId)
    assert(after.previewUrl===current.previewUrl && after.quality===current.quality,'Stale render replaced the latest result.')
    races.push({preview,quality:after.quality})
  }
  const editTime=await evaluate(cdp,sessionId,'performance.now()')
  await setControlValue(cdp,sessionId,'#quality','0.69')
  await waitForFullOutput(cdp,sessionId)
  const fullTime=await evaluate(cdp,sessionId,`window.__e2eWorkerProcessGate.requests.findLast(r=>!r.preview && r.quality===0.69).time`)
  assert(fullTime-editTime>=590,'Automatic full output ran before the 600ms idle interval.')
  // Full-output failure stops retrying until explicitly requested.
  await evaluate(cdp,sessionId,'window.__e2eWorkerProcessGate.arm(false)')
  await setControlValue(cdp,sessionId,'#quality','0.63')
  await waitForDom(cdp,sessionId,'window.__e2eWorkerProcessGate.held','held automatic full output')
  await evaluate(cdp,sessionId,'window.__e2eWorkerProcessGate.injectError()')
  await waitForDom(cdp,sessionId,`document.querySelector('.verify-output-button') !== null && !document.querySelector('.status-chip').classList.contains('is-busy')`,'recoverable full error')
  await delay(700)
  assert(await evaluate(cdp,sessionId,`document.querySelector('.full-output-bytes-value').textContent==='計算できませんでした'`),'Failed output was presented as measured.')
  await clickButton(cdp,sessionId,'容量計算を再試行')
  await waitForFullOutput(cdp,sessionId)

  // Retain deterministic decode, reset and invalid-file/preview race regressions.
  await installDecodeGate(cdp,sessionId)
  await runLatestCandidateOrderingRegression({cdp,sessionId,cropDragFixturePath,fixturePath,decodeSupported:true})
  await runConcurrentDecodeEditResetRegression({cdp,sessionId,fixturePath,decodeSupported:true})
  await runNoopOutputInvalidationRegression({cdp,sessionId,fixturePath,selector:'#quality',valueKey:'quality',label:'same quality'})
  await runNoopOutputInvalidationRegression({cdp,sessionId,fixturePath,selector:'#output-format',valueKey:'outputMime',label:'same MIME'})
  await runCancelledExportEditRegression({cdp,sessionId,fixturePath,downloadDirectory})
  for (const candidate of [fixturePath, corruptFixturePath, unsupportedFixturePath]) {
    await runCancelledExportSelectionRegression({cdp,sessionId,fixturePath,downloadDirectory,candidateFixturePath:candidate,expectedSourceDimensions:candidate===fixturePath?'16 × 32 px':undefined})
  }
  await runFailedEncodeSettlementRegression({cdp,sessionId,fixturePath})
  await runPendingInvalidReplacementRegression({cdp,sessionId,fixturePath,invalidFixturePath:corruptFixturePath,pendingFixturePath:cropDragFixturePath,phase:'initial in-flight',invalidLabel:'corrupt'})
  await installPreviewDebounceGate(cdp,sessionId)
  await runPreDebounceInvalidReplacementRegression({cdp,sessionId,fixturePath,invalidFixturePath:unsupportedFixturePath,invalidLabel:'unsupported',pendingFixturePath:cropDragFixturePath})
  await removeE2EGates(cdp,sessionId)

  // Tiny crops and rounded reduced previews must keep a single aligned frame.
  await setFileInput(cdp,sessionId,cropDragFixturePath)
  await waitForFullOutput(cdp,sessionId)
  await setControlValue(cdp,sessionId,'#output-format','image/png')
  await evaluate(cdp,sessionId,`document.querySelector('[data-aspect-ratio="free"]').click()`)
  await setControlValue(cdp,sessionId,'#resize-width','1001')
  await setControlValue(cdp,sessionId,'.crop-coordinates label:nth-child(3) input','7')
  await setControlValue(cdp,sessionId,'.crop-coordinates label:nth-child(4) input','3')
  await waitForFullOutput(cdp,sessionId)
  await selectEditorView(cdp,sessionId,'compare')
  const rounded=await evaluate(cdp,sessionId,`(()=>{const r=document.querySelector('.processed-preview').getBoundingClientRect(),v=document.querySelector('.comparison-viewport').getBoundingClientRect();return {quickWidth:Number(document.querySelector('.workspace').dataset.quickWidth),quickHeight:Number(document.querySelector('.workspace').dataset.quickHeight),error:Math.abs(r.width-v.width)+Math.abs(r.height-v.height)}})()`)
  assert(rounded.quickWidth===960 && rounded.quickHeight===411 && rounded.error<1,'Rounded preview geometry drifted.')
  await setControlValue(cdp,sessionId,'#resize-width','')
  await setControlValue(cdp,sessionId,'.crop-coordinates label:nth-child(3) input','1')
  await setControlValue(cdp,sessionId,'.crop-coordinates label:nth-child(4) input','1')
  await waitForFullOutput(cdp,sessionId)
  assert(await evaluate(cdp,sessionId,`document.querySelector('.processed-preview').naturalWidth===1 && document.querySelector('.processed-preview').naturalHeight===1`),'Tiny crop did not produce a 1px result.')

  // At the result endpoint, transparency must show the checker/base, not the original.
  const transparentPng=await evaluate(cdp,sessionId,`(()=>{const c=document.createElement('canvas');c.width=80;c.height=60;const x=c.getContext('2d');x.fillStyle='red';x.fillRect(0,0,40,60);return c.toDataURL().split(',')[1]})()`)
  const transparentPath=join(dirname(cropDragFixturePath),'transparent.png')
  await writeFile(transparentPath,Buffer.from(transparentPng,'base64'))
  await setFileInput(cdp,sessionId,transparentPath)
  await waitForFullOutput(cdp,sessionId)
  await selectEditorView(cdp,sessionId,'compare')
  await evaluate(cdp,sessionId,`document.querySelector("#comparison-split").focus()`)
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36},sessionId)
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36},sessionId)
  await waitForDom(cdp,sessionId,`document.querySelector("#comparison-split").value==='0'`,'result comparison endpoint')
  const transparent=await evaluate(cdp,sessionId,`(()=>{const img=document.querySelector('.processed-preview'),c=document.createElement('canvas');c.width=80;c.height=60;const x=c.getContext('2d');x.drawImage(img,0,0);const style=getComputedStyle(document.querySelector('.comparison-result-layer'));return {alpha:x.getImageData(70,30,1,1).data[3],checker:style.backgroundImage,background:style.backgroundColor,hidden:document.querySelector('.comparison-original-layer').getAttribute('aria-hidden')}})()`)
  assert(transparent.alpha===0 && transparent.checker!=='none' && transparent.background!=='rgba(0, 0, 0, 0)' && transparent.hidden==='true','Transparency leaked the original comparison layer.')
  await setControlValue(cdp,sessionId,'#output-format','image/webp')
  await waitForFullOutput(cdp,sessionId)
  assert(await evaluate(cdp,sessionId,`window.__e2eBlobs.get(document.querySelector('.processed-preview').src).type==='image/webp'`),'WebP output was not encoded.')
  await setControlValue(cdp,sessionId,'#output-format','image/jpeg')
  await waitForFullOutput(cdp,sessionId)
  assert(await evaluate(cdp,sessionId,'window.__e2eBlobs.size===2 && window.__e2eRevoked.length>10'),'Source/rendered object URLs were not released on replacement.')

  // A 12 MP panorama must render both quick and full crops without expanded canvases.
  await setOutputPanel(cdp,sessionId,false)
  const panoramaPng = await evaluate(cdp,sessionId,`(()=>{const c=document.createElement('canvas');c.width=12000;c.height=1000;const x=c.getContext('2d');x.fillStyle='rgb(60,120,180)';x.fillRect(0,0,c.width,c.height);return c.toDataURL().split(',')[1]})()`)
  const panoramaPath = join(dirname(cropDragFixturePath),'panorama.png')
  await writeFile(panoramaPath,Buffer.from(panoramaPng,'base64'))
  await setFileInput(cdp,sessionId,panoramaPath)
  await waitForDom(cdp,sessionId,`document.querySelector('.stage-image')?.naturalWidth===12000 && document.querySelector('.processed-preview')?.dataset.previewKind==='quick' && !document.querySelector('.download-button').disabled`, 'panorama quick preview')
  await setControlValue(cdp,sessionId,'#output-format','image/png')
  await setControlValue(cdp,sessionId,'#resize-width','2048')
  await clickButton(cdp,sessionId,'傾き・反転')
  await setControlValue(cdp,sessionId,'#straighten','45')
  await waitForDom(cdp,sessionId,`document.querySelector('.processed-preview')?.naturalWidth===960 && !document.querySelector('.download-button').disabled`, 'straightened panorama quick crop')
  await setOutputPanel(cdp,sessionId,true)
  await waitForFullOutput(cdp,sessionId)
  const panorama = await evaluate(cdp,sessionId,`(async()=>{const img=document.querySelector('.processed-preview');await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const bytes=x.getImageData(0,0,c.width,c.height).data;let empty=0;for(let i=3;i<bytes.length;i+=4)if(bytes[i]===0)empty++;return {width:c.width,height:c.height,empty,center:[...x.getImageData(c.width/2,c.height/2,1,1).data]}})()`)
  assert(panorama.width===2048 && panorama.height===171 && panorama.empty===0 && panorama.center.join(',')==='60,120,180,255', 'Panorama full crop failed: '+JSON.stringify(panorama))

  await setFileInput(cdp,sessionId,fixturePath)
  await waitForFullOutput(cdp,sessionId)
  await setControlValue(cdp,sessionId,'#output-format','image/jpeg')
  await waitForFullOutput(cdp,sessionId)
  const metadataBytes=await evaluate(cdp,sessionId,`(async()=>Array.from(new Uint8Array(await window.__e2eBlobs.get(document.querySelector('.processed-preview').src).arrayBuffer())))()`)
  const metadata=detectMetadataFamilies(Buffer.from(metadataBytes))
  assert(Object.values(metadata).every(v=>!v),'Source EXIF/GPS/ICC/XMP/IPTC/comment survived encoding.')
  const dimensions=parseJpegDimensions(Buffer.from(metadataBytes))
  assert(dimensions.width===16 && dimensions.height===32,'Normalized export dimensions changed.')
  diagnostics.assertClean()
  const requests=network.getObservedRequests()
  assertNetworkIsLocal(requests,origin,{allowedPaths,requestLog})
  return {layouts,pixels,comparison,capacity,races,metadata:{source:sourceFamilies,sourceExifOrientation:sourceOrientation,output:metadata},dimensions,network:formatNetworkReport(requests),browserTarget:await getTargetInfo(cdp,targetId)}
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

    report = await runScenario({
      allowedPaths,
      basePath,
      corruptFixturePath,
      cropDragFixturePath,
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
