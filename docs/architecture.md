# Architecture

**Audience / trigger:** image transform、crop geometry、Worker、metadata、privacy boundary、または browser lifecycle を変更する人は、実装前に読む。ここは現行コードの stable seam を説明する場所であり、将来構想の置き場ではない。

## Boundary and dataflow

アプリは画像をサーバーへ送らず、build された static assets とブラウザの File/Canvas/Worker API だけで処理する。主経路は次の通り。

```text
File/drop
  → decodeImageFile: EXIF orientation を適用した normalized pixels
  → App の ImageEditState + calculateImageGeometry
  → RasterProcessor.process
  → worker protocol: sourceKey / generation / requestId
  → one-active / one-latest scheduler + source cache
  → OffscreenCanvas: normalize → rotate/flip → final crop → resize
  → Canvas encode
  → stripEncodedMetadata (fail closed)
  → Blob / RasterResult
  → App の object URL、metrics、download
```

`App` は編集変更後に debounce された reduced-resolution の quick preview を要求し、出力設定パネルを開いている間に限り、編集停止から600ms経過し quick preview が完了すると full output size を自動で要求する。失敗時の再試行と download も full output size を要求する。同じ編集 intent の確認済み full result があれば download はその Blob を再利用する。quick/full の容量値と比較表示はそれぞれの result identity に結び付き、両者は同じ geometry の crop/transform semantics を共有する。実装の詳細は [App.tsx](../src/App.tsx) と [raster.ts](../src/image/raster.ts) を参照する。

## Module contracts and seams

| module | stable interface / ownership |
| --- | --- |
| `src/App.tsx` | browser UI、File input/drop、編集 intent、単一画像領域の編集・比較切替、折りたたみ出力設定、quick/full comparison、preview/download の採用、source/rendered object URL の所有。画像の座標算術を持たず `geometry` に渡す。選択中の candidate と committed source/result を分離する。 |
| `src/app-async.ts` | `ResultIntent` と `isSameResultIntent`。source/edit object identity、output MIME、quality の一致だけを判定する pure seam。 |
| `src/image/geometry.ts` | `ImageEditState`、`calculateImageGeometry`、`constrainCrop`、`rotateEditState`。display size、final-display crop、source mapping、cropped/output size の arithmetic を所有する。 |
| `src/image/stage.ts` | `createStageTransform` と crop surface style。CSS 表示文字列だけを組み立て、Canvas のピクセル処理は所有しない。 |
| `src/image/raster.ts` | `RasterProcessor` の公開面は `process(source, editState, output)`、`clearSource()`、`dispose()`。decode、MIME/options 検証、source identity/cache、pending Promise と Worker messaging を所有する。 |
| `src/image/worker-protocol.ts` | process/clear message の validation と `ProcessingPlan`。Worker の外から来る値を信頼せず、geometry と preview render size を組み合わせる。 |
| `src/image/worker-scheduler.ts` | `enqueueLatest`、`completeLatest`、`clearLatest` の pure state machine。active は1件、queued は最新1件だけを表す。 |
| `src/image/raster.worker.ts` | browser Worker 側の source cache、OffscreenCanvas、rotate/flip/crop/resize、`convertToBlob`、metadata strip、response。DOM/UI state は持たない。 |
| `src/image/encoded-metadata.ts` | encoded bytes の形式検証と container metadata strip。Canvas や DOM に依存しない pure byte seam。 |

算術の変更は geometry/scheduler/byte parser の focused unit test で説明する。Canvas、File、URL、Worker、CDP、download の変更は browser-effect boundary の E2E evidence まで必要である。

## State, cache, and stale requests

full出力の自動計算は既存のrequest id・intent guardで採用を制御し、編集中および出力設定パネルを閉じたときはタイマーを破棄する。すでに開始したfull処理は中断せず完了まで継続するため、その間の新しいpreviewは既存schedulerの契約どおり待機する。失敗時は自動ループを止めて再試行を提示する。容量バーはmetadata strip後のfull Blobと元Fileのbytesを共通スケールで表示し、容量増加も許容する。quickのbytesは保存容量として表示しない。

1. File を受け取ると `App` は candidate として MIME を検査し、decode 完了を `fileLoadGeneration` で guard する。candidate の読み込み中・失敗時は committed source、編集、result URL、現行 preview の debounce/in-flight work を保持する。新しい選択は論理的に obsolete な export と candidate を無効化し、比較表示を解放する。
2. candidate の decode が成功した時だけ、`App` は result intent を無効化してから `clearSource()` を呼び、旧 rendered/source URL を解放し、新しい source/edit を committed state にする。decode 失敗や MIME 不一致で committed state を捨てない。reset は candidate generation を進めて candidate を取り消し、committed source の編集だけを再処理する。
3. `RasterProcessor` は同じ decoded pixel object を `sourceIdentity` で認識し、初回だけ pixel buffer の copy を `sourceKey` 付きで transfer する。後続 request は cache key を渡す。
4. `clearSource()` は source key を捨て、generation を増やし、pending Promise を reject してから Worker に clear message を送る。Worker は cache を空にし、clear より前の queued request を stale にする。
5. Worker scheduler は active を中断せず保持するが、新世代の request は queued にできる。active が終わると旧結果は stale、次の世代の最新 request が start する。queued が置き換わると置き換えられた request も stale になる。
6. `App` は `candidatePending/fileError`、`previewPending/processingError`、`exportPending` を別々に所有し、`busy` をそれらの組み合わせから導出する。preview は request id と intent generation、download は request id と generation と source/edit/output identity を確認する。どの guard も一致しなければ UI、metrics、download に結果を採用しない。
7. Worker error/stale、decode error、dispose は pending work を成功扱いにしない。unmount は processor を dispose し、残った source/rendered URL を revoke する。

この protocol では「古い処理を速く止められる」ことではなく、「古い処理が完了しても観測可能な current result にならない」ことが correctness の中心である。

## Transform and coordinate contract

`DecodedSourcePixels` は decode 時点で source orientation を正規化した RGBA pixel buffer である。`createImageBitmap(file, { imageOrientation: 'from-image' })` が主経路で、bitmap は readback 後に close する。fallback の drawable 経路も同じ normalized-pixels interface を返す。

`ImageEditState.straighten` は −45〜45 度の有限値で、未指定は0度。Worker境界で範囲・型を検証する。`geometry.straightening` が角度と自動拡大倍率を所有し、CSS stage・比較画像・Workerで共有する。90度回転後の表示寸法を W×H、傾きを θ として、倍率は `max(cosθ + H/W × |sinθ|, cosθ + W/H × |sinθ|)`。中心回転後に表示枠全体を覆う最小倍率であり、傾き変更だけでは表示寸法・crop・出力寸法を変えない。`sourceCrop` は最終軸のflip、傾き・拡大、90度回転を逆変換した四隅のbounding boxである。

`CropRect` の座標は常に **final displayed-orientation pixels** で表す。したがって、90/270 度では `displaySize` の width/height が入れ替わり、flip はその最終表示軸に対して適用される。`sourceCrop` はこの crop を rotation/flip を逆写像して source 座標へ説明する値であり、UI crop を source 向きで再解釈してはならない。

絶対的な順序は次の通りである。

1. normalized source pixels を Canvas に置く。
2. `rotation` と `straighten` による中心回転・自動拡大で display canvas を作る。
3. `flipHorizontal` / `flipVertical` を display canvas の最終軸で適用する。
4. final-display の `geometry.crop` を切り出す。
5. `geometry.outputSize`（preview ならその比例縮小）へ resize する。
6. requested MIME へ encode し、metadata を strip する。

`stage.ts` の CSS string は合成角度の `rotate(...)` を rightmost に置き、傾きがある場合は自動拡大を挟む。CSS transform は右から適用されるため、rotate が先、scaleX/scaleY が後となり、Worker の rotate-then-final-axis-flip と一致する。rotation、flip、crop、resize のどれかの順番を変えたら、geometry/stage unit と Chromium pixel evidence を同時に更新する。

## Encoded metadata policy

worker は `convertToBlob` の MIME を要求値と照合し、bytes を `stripEncodedMetadata` に渡す。parser が signature、length、chunk、marker、RIFF size などを検証できなければ render 全体を error にし、未検証 bytes を result にしない。strip 後に作る Blob の MIME も再確認する。

- **JPEG:** APPn と COM を metadata として扱う。JFIF の APP0 と Adobe の APP14 は decoder/container に必要な構造情報として保持し、それ以外の APPn と COM は削除する。SOI、SOF、量子化/Huffman 等の構造 segment と SOS 以降の entropy scan は保持する。scan 内の stuffed bytes を metadata と誤認しない。
- **PNG:** signature、IHDR、PLTE、tRNS、IDAT、IEND など decoding/pixel に必要な chunk を保持し、eXIf、iCCP、text、time、color-profile 等の既知 metadata ancillary chunk を削除する。未知の critical chunk は decoding に影響し得るため保持し、未知の ancillary chunk は保持しない。
- **WebP:** RIFF/WEBP、chunk length/padding を検証し、ICCP、EXIF、XMP chunk を削除する。他の decoding/pixel chunk は保持し、VP8X の metadata feature bits と RIFF size を更新する。入力 decode では animation signature を拒否し、v1 は静止画 WebP に限る。

この policy は元 File の metadata を再注入しない設計とセットである。元画像は pixels へ decode され、出力は新しい container として encode される。未知の構造を「metadata らしい」と推測して削除しないことが fail-closed の一部である。

## Privacy, network, and CSP boundary

ユーザー向けプライバシーポリシーの本文は [docs/privacy.md](privacy.md) が所有する。ここでは実装境界、CSP、network contract、runtime/test evidence を扱う。

`index.html` の CSP は、アプリの same-origin runtime を基本に、Cloudflare Pages の managed Web Analytics injection のため `script-src 'self' https://static.cloudflareinsights.com` を許可する。`connect-src 'self'`、`font-src 'self'`、`worker-src 'self' blob:` などは維持する。Worker asset は同じ build の static asset として読み込まれる。

**App runtime / local E2E:** アプリは画像をブラウザ内で処理し、upload endpoint、backend、アプリ独自の analytics/telemetry、外部 font を持たない。Vite の build/static server は Cloudflare Pages の managed injection を行わないため、local production build の HTML には beacon script が注入されず、Chromium E2E の authority は built static surface、local origin、read-only HTTP、POST zero、third-party zero のままである。`scripts/e2e-network.mjs` はこの境界を緩めず、analytics path も拒否する。

**Production hosting:** Cloudflare Pages は `https://static.cloudflareinsights.com/beacon.min.js` を managed script として注入し、同一 origin の `/cdn-cgi/rum` へ reporting する。本番の許可範囲は page/access/performance metrics（page views/visits、host/path/referrer、country、device/browser/OS、navigation type、page-load timing/Core Web Vitals）に限り、選択画像由来の file name、MIME、metadata、content、pixels、bytes や custom event は送信しない。`connect-src` に Cloudflare origin を追加しないのは、reporting が same-origin だからである。Rocket Loader は hosting-managed optimization のままとし、source では opt out しない。

Chromium E2E は CDP の HTTP/WebSocket 観測と static-server request log を突き合わせる。許可されるのは BASE_PATH 下の built HTML/asset/favicon の read-only request だけで、third-party origin、WebSocket、POST、upload/telemetry/analytics path、failed/non-200 request は失敗とする。CSP や network harness を緩めて機能を通してはならない。

## Resource ownership

- `decodeImageFile` は `ImageBitmap` を `finally` で close し、fallback の temporary object URL を revoke する。
- `App` は candidate decode/commit に失敗した一時 object URL を revoke し、成功した candidate の source URL を committed source として次の成功 commit・unmount で置き換え/revoke する。rendered result の URL も次の採用・reset・unmount で revoke する。
- `RasterProcessor.dispose()` は pending work を reject し、Worker reference を terminate する。`clearSource()` は Worker cache を世代境界で無効化する。
- Worker の Canvas は render request の局所値として保持し、source pixel ArrayBuffer の cache と message transfer の所有を混同しない。download anchor は click 後に DOM から外す。

リソースの作成・transfer・release の所有者を変える変更は、stale request の採用 guard と cleanup の両方を確認する。

## Test evidence and acceptance boundary

| evidence | proves |
| --- | --- |
| `src/image/geometry.test.ts` | display dimensions、final-display crop、aspect、zoom/pan、rotation、resize、flip の source mapping |
| `src/image/stage.test.ts` | CSS transform の rotation/flip order と crop surface sizing |
| `src/image/raster.test.ts` / `raster.processor.test.ts` | MIME/options、preview sizing、worker request validation、clear generation と pending lifecycle |
| `src/image/worker-scheduler.test.ts` | one-active/one-latest、queue replacement、clear generation、stale event |
| `src/image/encoded-metadata.test.ts` | JPEG APP/COM、PNG chunk、WebP chunk/RIFF の removal/retention と malformed input の fail-closed |
| `scripts/e2e-jpeg.test.mjs` / `e2e-network.test.mjs` | metadata fixture と local static/network assertion の helper contract |
| `pnpm run test:e2e` | built app を実 Chrome で BASE_PATH 配下に開き、EXIF orientation、実 Worker preview、rotate/flip/crop/resize pixels、download dimensions、JPEG metadata-free output、browser diagnostics、local-only network を確認 |

Browser coverage と E2E の実行範囲は [development.md](development.md) が所有する。
