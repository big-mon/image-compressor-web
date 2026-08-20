# image-compressor-web

ブラウザ内で画像をトリミング・圧縮する、独立した静的 React + TypeScript + Vite アプリです。

## 前提環境

- Node.js `>=22.13`
- pnpm `11.22.0`

## 開発コマンド

```sh
pnpm install --frozen-lockfile
pnpm run dev
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
```

Hub のサブパスで配信する場合は、ビルド時に `BASE_PATH` を渡します。

```sh
BASE_PATH=/image-compressor-web/ pnpm run build
```

## Chromium E2E

実ブラウザ受け入れテストは、依存関係を追加せず Chrome DevTools Protocol で実行します。次のChrome実行ファイルが必要です。

`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`（Chrome 151で確認済み）

本番ビルドを作成してから、ループバック上の `/image-compressor-web/` で実行してください。

```sh
BASE_PATH=/image-compressor-web/ pnpm run build
BASE_PATH=/image-compressor-web/ pnpm run test:e2e
```

テストは一時Chromeプロファイル・ダウンロード先・JPEG fixtureを作成し、終了時に削除します。Chromium以外（Safari／Firefox）の互換性はこのテストの対象外で、別途手動確認が必要です。

## プライバシーとスコープ

このアプリは画像をブラウザ内で処理し、画像をアップロードするバックエンドやAPIを持ちません。分析、テレメトリー、外部フォント、外部ランタイムアセット、画像アップロード先も追加しません。

JPEG・PNG・WebPを選択し、ズーム・パン・比率指定付きのクロップ、90度回転、反転、リサイズ、形式・品質指定、Worker生成プレビュー、容量比較、ダウンロードまでをブラウザ内で行えます。変換順序は、ソース向きの正規化、回転・反転、最終表示向きでのクロップ、リサイズ、エンコード／圧縮です。メタデータを保持・再注入せず、変換後のピクセルラスタをエクスポート元にします。

サーバーAPI、アカウント、データベース、バッチ処理、クラウド保存プリセット、目標KB自動最適化、HEIC、AVIF、GIF、アニメーションWebP、メタデータ保持はv1の対象外です。
