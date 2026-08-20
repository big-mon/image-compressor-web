function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export function originForRequest(url) {
  const parsed = new URL(url)
  if (parsed.protocol === 'ws:') {
    return `http://${parsed.host}`
  }
  if (parsed.protocol === 'wss:') {
    return `https://${parsed.host}`
  }
  return parsed.origin
}

export function createStaticSurfaceAllowlist(basePath, assetPaths) {
  assert(basePath.startsWith('/') && basePath.endsWith('/'), `Static surface base path must start and end with '/': ${basePath}`)
  const paths = new Set([
    basePath,
    `${basePath}favicon.svg`,
    ...assetPaths,
  ])
  for (const pathname of paths) {
    assert(pathname.startsWith(basePath), `Static surface path is outside BASE_PATH: ${pathname}`)
  }
  return paths
}

function serverEvidenceForRequest(request, requestLog, usedServerRequestIndexes) {
  const parsed = new URL(request.url)
  const method = String(request.method ?? '').toUpperCase()
  const matchingIndex = requestLog.findIndex((serverRequest, index) => (
    !usedServerRequestIndexes.has(index) &&
    String(serverRequest.method ?? '').toUpperCase() === method &&
    serverRequest.pathname === parsed.pathname &&
    serverRequest.statusCode === 200
  ))
  if (matchingIndex < 0) {
    return false
  }
  usedServerRequestIndexes.add(matchingIndex)
  return true
}

export function assertNetworkIsLocal(requests, expectedOrigin, { allowedPaths, requestLog = [] } = {}) {
  assert(allowedPaths && typeof allowedPaths.has === 'function', 'The browser static surface allowlist is missing.')

  const websocketRequests = requests.filter((request) => request.kind === 'websocket')
  assert(websocketRequests.length === 0, `WebSocket request observed, including same-origin sockets: ${JSON.stringify(websocketRequests)}`)

  const externalRequests = requests.filter((request) => originForRequest(request.url) !== expectedOrigin)
  assert(externalRequests.length === 0, `Third-party network request observed: ${JSON.stringify(externalRequests)}`)

  const httpRequests = requests.filter((request) => request.kind === 'http')
  const uploadRequests = httpRequests.filter((request) => {
    const method = String(request.method ?? '').toUpperCase()
    return request.hasPostData === true || !['GET', 'HEAD'].includes(method) || /(?:upload|telemetry|analytics)/i.test(new URL(request.url).pathname)
  })
  assert(uploadRequests.length === 0, `Image upload or mutating request observed: ${JSON.stringify(uploadRequests)}`)

  const unexpectedPaths = httpRequests.filter((request) => !allowedPaths.has(new URL(request.url).pathname))
  assert(unexpectedPaths.length === 0, `Browser HTTP request escaped the built static surface: ${JSON.stringify(unexpectedPaths)}`)

  const failedRequests = httpRequests.filter((request) => request.failed === true)
  assert(failedRequests.length === 0, `Browser HTTP request failed: ${JSON.stringify(failedRequests)}`)

  const unsuccessfulResponses = httpRequests.filter((request) => request.status !== undefined && request.status !== null && request.status !== 200)
  assert(unsuccessfulResponses.length === 0, `Allowlisted browser request did not return HTTP 200: ${JSON.stringify(unsuccessfulResponses)}`)

  const usedServerRequestIndexes = new Set()
  const missingStatusEvidence = httpRequests.filter((request) => request.status === undefined || request.status === null)
  const missingEvidence = missingStatusEvidence.filter((request) => !serverEvidenceForRequest(request, requestLog, usedServerRequestIndexes))
  assert(missingEvidence.length === 0, `Allowlisted browser request has no successful server-side 200 evidence: ${JSON.stringify(missingEvidence)}`)
}
