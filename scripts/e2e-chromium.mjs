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
const EXPECTED_H1 = '画像を、ブラウザの中だけで整える。'
const EXPECTED_EXTERNAL_LINKS = [
  { href: 'https://x.com/big_mon', text: 'X @big_mon' },
  { href: 'https://github.com/big-mon/image-compressor-web', text: 'GitHub ソースコード' },
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

async function assertPublicMetadataAndFooter(cdp, sessionId) {
  const pageContract = await evaluate(cdp, sessionId, `(() => {
    const serializeAnchor = (anchor) => ({
      href: anchor.href,
      rel: anchor.getAttribute('rel') ?? '',
      target: anchor.getAttribute('target') ?? '',
      text: anchor.textContent?.trim() ?? '',
    })
    const canonicalLinks = document.querySelectorAll('link[rel="canonical"]')
    const descriptionMetas = document.querySelectorAll('meta[name="description"]')
    const footerNavigation = document.querySelectorAll('footer nav[aria-label="外部リンク"]')
    return {
      canonical: canonicalLinks[0]?.getAttribute('href') ?? '',
      canonicalCount: canonicalLinks.length,
      description: descriptionMetas[0]?.getAttribute('content') ?? '',
      descriptionCount: descriptionMetas.length,
      externalAnchors: [...document.querySelectorAll('a[href]')]
        .filter((anchor) => /^https?:/i.test(anchor.href))
        .map(serializeAnchor),
      footerLinks: [...footerNavigation].flatMap((navigation) => [...navigation.querySelectorAll('a[href]')].map(serializeAnchor)),
      footerNavigationCount: footerNavigation.length,
      h1s: [...document.querySelectorAll('h1')].map((heading) => heading.textContent?.trim() ?? ''),
      title: document.title,
    }
  })()`)

  assert(pageContract.title === EXPECTED_TITLE, `Unexpected document title: ${JSON.stringify(pageContract.title)}`)
  assert(pageContract.canonicalCount === 1 && pageContract.canonical === EXPECTED_CANONICAL, `Unexpected canonical URL: ${JSON.stringify(pageContract)}`)
  assert(pageContract.descriptionCount === 1 && pageContract.description === EXPECTED_DESCRIPTION && pageContract.description.length > 0, `Unexpected meta description: ${JSON.stringify(pageContract)}`)
  assert(pageContract.h1s.length === 1 && pageContract.h1s[0] === EXPECTED_H1, `Expected exactly one H1 with the current visible text: ${JSON.stringify(pageContract.h1s)}`)
  assert(pageContract.footerNavigationCount === 1, `Expected one external-link footer navigation: ${pageContract.footerNavigationCount}`)
  assert(pageContract.footerLinks.length === EXPECTED_EXTERNAL_LINKS.length, `Unexpected footer link count: ${JSON.stringify(pageContract.footerLinks)}`)

  for (const expectedLink of EXPECTED_EXTERNAL_LINKS) {
    const link = pageContract.footerLinks.find((candidate) => candidate.href === expectedLink.href)
    assert(link, `Missing footer link: ${expectedLink.href}`)
    assert(link.text === expectedLink.text && link.text.length > 3, `Footer link text is not descriptive for ${expectedLink.href}: ${JSON.stringify(link.text)}`)
    assert(link.target === '_blank', `Footer link must use target=_blank: ${JSON.stringify(link)}`)
    const relTokens = new Set(link.rel.toLowerCase().split(/\s+/).filter(Boolean))
    assert(relTokens.has('noopener') && relTokens.has('noreferrer'), `Footer link is missing safe rel tokens: ${JSON.stringify(link)}`)
  }

  for (const externalAnchor of pageContract.externalAnchors) {
    assert(externalAnchor.target === '_blank', `External anchor must use target=_blank: ${JSON.stringify(externalAnchor)}`)
    const relTokens = new Set(externalAnchor.rel.toLowerCase().split(/\s+/).filter(Boolean))
    assert(relTokens.has('noopener') && relTokens.has('noreferrer'), `External anchor is missing safe rel tokens: ${JSON.stringify(externalAnchor)}`)
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

  await cdp.send('Network.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Log.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await evaluate(cdp, sessionId, `(() => {
    window.addEventListener('error', (event) => console.error('[e2e] window error', event.error?.stack || event.message))
    window.addEventListener('unhandledrejection', (event) => console.error('[e2e] unhandled rejection', event.reason?.stack || String(event.reason)))
  })()`)

  await cdp.send('Page.navigate', { url: pageUrl }, sessionId)
  await waitForDom(cdp, sessionId, `document.readyState === 'complete' && document.querySelector('input[type="file"]') !== null`, 'the built app to load')
  await assertPublicMetadataAndFooter(cdp, sessionId)
  await setFileInput(cdp, sessionId, fixturePath)
  await waitForFileLoad(cdp, sessionId)
  await waitForDom(cdp, sessionId, `document.querySelector('.comparison-card:first-child figcaption span:last-child')?.textContent?.trim() === '16 × 32 px'`, 'the normalized source dimensions')
  await waitForDom(cdp, sessionId, `document.querySelector('.status-chip')?.textContent?.trim() === 'プレビュー準備完了'`, 'the initial Worker preview')

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
      heightCapPx: rootFontSize * 42,
      rootFontSize,
    }
  })()`)
  assert(initialLayout.sourceDimensions === '16 × 32 px', `App source dimensions were not normalized: ${JSON.stringify(initialLayout)}`)
  assert(initialLayout.sourceNaturalWidth === 16 && initialLayout.sourceNaturalHeight === 32, `Source img natural dimensions were not normalized: ${JSON.stringify(initialLayout)}`)
  assert(Math.abs(initialLayout.surfaceRatio - 0.5) <= 0.01, `Portrait crop surface ratio was not preserved: ${JSON.stringify(initialLayout)}`)
  assert(initialLayout.surfaceHeight <= initialLayout.heightCapPx + 1, `Crop surface exceeded the 42rem height cap: ${JSON.stringify(initialLayout)}`)

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
  const downloadedFilename = 'e2e-metadata-fixture-edited.jpg'
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
