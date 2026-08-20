import { describe, expect, it } from 'vitest'

import {
  assertNetworkIsLocal,
  createStaticSurfaceAllowlist,
} from './e2e-network.mjs'

const origin = 'http://127.0.0.1:4173'
const basePath = '/image-compressor-web/'
const allowedPaths = createStaticSurfaceAllowlist(basePath, [
  `${basePath}assets/index-abc123.js`,
  `${basePath}assets/index-def456.css`,
  `${basePath}assets/raster.worker-ghi789.js`,
])

function httpRequest(pathname, overrides = {}) {
  return {
    hasPostData: false,
    kind: 'http',
    method: 'GET',
    status: 200,
    url: `${origin}${pathname}`,
    ...overrides,
  }
}

describe('browser network privacy harness', () => {
  it('allows only the built static surface over read-only HTTP', () => {
    expect(() => assertNetworkIsLocal([
      httpRequest(basePath),
      httpRequest(`${basePath}favicon.svg`),
      httpRequest(`${basePath}assets/index-abc123.js`),
      httpRequest(`${basePath}assets/index-def456.css`),
      httpRequest(`${basePath}assets/raster.worker-ghi789.js`),
    ], origin, { allowedPaths })).not.toThrow()
  })

  it('rejects a same-origin image/data collection pathname', () => {
    expect(() => assertNetworkIsLocal([
      httpRequest(`${basePath}collect?image=secret`),
    ], origin, { allowedPaths })).toThrow(/static surface/i)
  })

  it('rejects same-origin WebSockets', () => {
    expect(() => assertNetworkIsLocal([
      {
        kind: 'websocket',
        method: 'GET',
        url: `ws://127.0.0.1:4173${basePath}collect`,
      },
    ], origin, { allowedPaths })).toThrow(/WebSocket/i)
  })

  it('rejects POST even when it targets an allowlisted pathname', () => {
    expect(() => assertNetworkIsLocal([
      httpRequest(basePath, { method: 'POST' }),
    ], origin, { allowedPaths })).toThrow(/upload|mutating|POST/i)
  })

  it('uses a successful static-server request as proof when CDP has no status', () => {
    expect(() => assertNetworkIsLocal([
      httpRequest(basePath, { status: undefined }),
    ], origin, {
      allowedPaths,
      requestLog: [{ method: 'GET', pathname: basePath, statusCode: 200 }],
    })).not.toThrow()

    expect(() => assertNetworkIsLocal([
      httpRequest(basePath, { status: undefined }),
    ], origin, { allowedPaths, requestLog: [] })).toThrow(/server.*200/i)
  })
})
