# image-compressor-web

ブラウザ内で画像をトリミング・圧縮する、独立した静的 React + TypeScript + Vite アプリです。

## Quick Start

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

## 開発者向けドキュメント

- 変更の入口、不変条件、最低限の検証、完了判定: [AGENTS.md](AGENTS.md)
- architecture、画像変換、Worker、metadata、privacy boundary: [docs/architecture.md](docs/architecture.md)
- setup、script の使い分け、BASE_PATH、Chromium E2E、completion gate: [docs/development.md](docs/development.md)

## プライバシーとスコープ

このアプリは画像をブラウザ内で処理し、画像をアップロードするバックエンドやAPIを持ちません。分析、テレメトリー、外部フォント、外部ランタイムアセット、画像アップロード先も追加しません。

JPEG・PNG・WebPを選択し、ズーム・パン・比率指定付きのクロップ、90度回転、反転、リサイズ、形式・品質指定、Worker生成プレビュー、容量比較、ダウンロードまでをブラウザ内で行えます。変換順序は、ソース向きの正規化、回転・反転、最終表示向きでのクロップ、リサイズ、エンコード／圧縮です。メタデータを保持・再注入せず、変換後のピクセルラスタをエクスポート元にします。

サーバーAPI、アカウント、データベース、バッチ処理、クラウド保存プリセット、目標KB自動最適化、HEIC、AVIF、GIF、アニメーションWebP、メタデータ保持はv1の対象外です。
