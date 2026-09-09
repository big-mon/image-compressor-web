import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const APP_ORIGIN = 'https://app.damonge.com'
const BASE_PATH = '/image-compressor-web/'
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const guideHtml = readFileSync(new URL('../public/guide.html', import.meta.url), 'utf8')
const guideMarkdown = readFileSync(new URL('../public/guide.md', import.meta.url), 'utf8')
const staticSection = indexHtml.match(/<details class="static-content"[\s\S]*?<\/details>/)?.[0] ?? ''

const guideContentAnchors = [
  'JPEG・PNG・WebP',
  'JPEG・PNG・WebPから選べます',
  'ブラウザの対応状況に左右され',
  'アニメーションWebP、HEIC、AVIF、GIFには対応していません',
  '必ず小さくなるとは限りません',
  'ロスレス変換ではなく再エンコード',
  '元の画素データから作り直し、メタデータを引き継いだり',
  '画像データは本アプリから外部へアップロードしません',
  'Cloudflare Web Analytics',
  'ファイル名、画像形式、メタデータ、画像の内容やデータそのものを解析情報として送信せず',
  '本アプリ独自のイベント計測も行いません',
  'JavaScriptが必要',
]

function resolveTemplateHref(rawHref, basePath) {
  return new URL(rawHref.replaceAll('%BASE_URL%', basePath), `${APP_ORIGIN}${basePath}`).href
}

function resolveGuideHref(rawHref) {
  return new URL(rawHref, `${APP_ORIGIN}${BASE_PATH}guide.html`).href
}

describe('static AEO content', () => {
  it('publishes a readable app description after the empty React root', () => {
    const rootEnd = indexHtml.indexOf('<div id="root"></div>')
    const staticStart = indexHtml.indexOf('<details class="static-content"')
    const moduleScriptStart = indexHtml.indexOf('<script type="module"')

    expect(rootEnd).toBeGreaterThanOrEqual(0)
    expect(staticStart).toBeGreaterThan(rootEnd)
    expect(moduleScriptStart).toBeGreaterThan(staticStart)
    expect(staticSection).toContain('<details class="static-content" open>')
    expect(staticSection).toContain('<summary id="static-content-title">')
    expect(staticSection).toContain('JPEG・PNG・WebP')
    expect(staticSection).toContain('画像データを外部へアップロードせず')
    expect(staticSection).toContain('Cloudflare Web Analytics')
    expect(staticSection).toContain('JavaScriptが必要')
    expect(staticSection).toMatch(/href="%BASE_URL%guide\.html"/)
    expect(staticSection).not.toMatch(/<noscript\b|\bhidden\b|visually-hidden|aria-hidden\s*=\s*"true"/i)
  })

  it('keeps the guide content equivalent in HTML and Markdown', () => {
    for (const anchor of guideContentAnchors) {
      expect(guideHtml).toContain(anchor)
      expect(guideMarkdown).toContain(anchor)
    }

    for (const heading of ['使い方', '対応形式と注意点', 'プライバシー', 'よくある質問']) {
      expect(guideHtml).toContain(`>${heading}<`)
      expect(guideMarkdown).toContain(`## ${heading}`)
    }

    for (const question of [
      'JavaScriptが無効でも使えますか？',
      '対応していない画像を扱えますか？',
      '圧縮すれば必ず容量が減りますか？',
      '回転はロスレスですか？',
    ]) {
      expect(guideHtml).toContain(question)
      expect(guideMarkdown).toContain(`### ${question}`)
    }
  })

  it('has one canonical per HTML page and advertises the Markdown alternate', () => {
    expect([...indexHtml.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((match) => match[1])).toEqual([
      `${APP_ORIGIN}${BASE_PATH}`,
    ])
    expect([...guideHtml.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((match) => match[1])).toEqual([
      `${APP_ORIGIN}${BASE_PATH}guide.html`,
    ])
    expect(guideHtml).toContain('<link rel="alternate" type="text/markdown" href="./guide.md"')
  })

  it('resolves app and guide links correctly at root and under BASE_PATH', () => {
    expect(resolveTemplateHref('%BASE_URL%guide.html', '/')).toBe(`${APP_ORIGIN}/guide.html`)
    expect(resolveTemplateHref('%BASE_URL%guide.html', BASE_PATH)).toBe(`${APP_ORIGIN}${BASE_PATH}guide.html`)
    expect(resolveGuideHref('./')).toBe(`${APP_ORIGIN}${BASE_PATH}`)
    expect(resolveGuideHref('./guide.md')).toBe(`${APP_ORIGIN}${BASE_PATH}guide.md`)
    expect(resolveGuideHref('./guide.html')).toBe(`${APP_ORIGIN}${BASE_PATH}guide.html`)
    expect(guideHtml).toContain('href="https://github.com/big-mon/image-compressor-web/blob/main/docs/privacy.md"')
    expect(guideHtml).toContain('href="https://github.com/big-mon/image-compressor-web"')
  })

  it('keeps the static guide available without JavaScript', () => {
    const guideBody = guideHtml.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? ''

    expect(guideBody).toContain('<main>')
    expect(guideBody).toContain('<h1>画像圧縮・編集の使い方</h1>')
    expect(guideBody).not.toMatch(/<script\b|<noscript\b/i)
    expect(guideBody).not.toMatch(/\bhidden\b|visually-hidden|aria-hidden\s*=\s*"true"/i)
    expect(guideHtml).toContain('href="./"')
    expect(guideHtml).toContain('href="./guide.md"')
  })
})
