# Contributor router

このリポジトリは、画像をブラウザ内だけで変換・圧縮する静的 React + TypeScript + Vite アプリである。Source of truth は executable code/config/tests > docs とし、README.md は product claims、package.json は script composition を所有する。

## まず読む場所

- Architecture、module seam、runtime contract、image transform、Worker、metadata、privacy boundary、その evidence: [docs/architecture.md](docs/architecture.md)
- Setup、test selection、verification、BASE_PATH、Chromium E2E、toolchain、automation status: [docs/development.md](docs/development.md)
- Product、privacy、scope の文言: [README.md](README.md)。主張は実装と E2E に trace する。

## 変更の入口ルール

- 変更前に、対象 module とその test、さらに境界を通る呼び出し元を読む。名前だけで seam を推測しない。
- 算術・parser・scheduler は pure seam に寄せ、File/Canvas/URL/Worker の browser effect を混ぜない。
- protocol、MIME、metadata、privacy の契約を変える場合は、実装・unit test・E2E evidence の三者を同じ変更として扱う。
- 文書は安価に確認できる package/config の snapshot を増やさず、owner と判断基準へリンクする。
- docs の説明がコードと食い違ったら、コード・config・tests を直ちに再確認し、主張を保留する。
- production code、tests、config、package/lock、scripts、GitHub/deployment settings は docs-only 作業の対象外である。

## ほぼすべての変更に効く不変条件

- **境界:** static browser-only。backend、image upload、analytics、runtime third-party call を追加しない。`index.html` の `connect-src 'self'` も維持する。
- **入力:** supported raster は JPEG / PNG / WebP のみ。animated WebP、HEIC、AVIF、GIF は v1 の入力契約に含めない。
- **変換順:** orientation normalize → rotate/flip → crop in final orientation → resize → encode。UI の見た目だけ別順序にしない。
- **出力プライバシー:** JPEG / PNG / WebP の encode 結果は必ず metadata stripping を通す。構造検証に失敗したら fail closed で Blob/result を返さない。
- **Worker:** one-active / one-latest。古い active は完了しても stale、queued は最新1件だけ。`clearSource()` は source generation を進め、clear 前の source/result を再利用させない。
- **UI adoption:** request id、intent generation、source/edit/output identity の guard を壊さず、stale preview や download を UI に採用しない。
- **lifecycle:** source/rendered object URL、`ImageBitmap`、Worker reference は所有者が release する。Worker は dispose 時に terminate する。
- **配信:** `BASE_PATH` の subpath 配信を壊さない。build と E2E で trailing-slash の base path を確認する。
- **tooling:** package manager は pnpm only。npm、別 repo の `node_modules` の link、package-lock を持ち込まない。

## Change → minimum verification

| 変更 | 最低限の gate |
| --- | --- |
| pure helper（geometry、stage、intent、options、protocol、scheduler） | `pnpm test <focused-test-file>` で選択を確認、`pnpm test`、`pnpm run typecheck`、`pnpm run lint`（該当するもの） |
| UI、Worker、container、metadata、privacy、decode/encode の境界 | `pnpm test`、`pnpm run typecheck`、`pnpm run lint`、`BASE_PATH=/image-compressor-web/ pnpm run build`、`BASE_PATH=/image-compressor-web/ pnpm run test:e2e` |
| toolchain、package.json、lockfile、Vite/E2E harness | `pnpm install --frozen-lockfile` を clean state で実行し、full unit・lint・typecheck・BASE_PATH build・Chromium E2E を通す |
| docs-only（契約を変えない） | relative-link/stale-claim check と `git diff --check`。契約・product claim を変えたら上の該当 gate を追加 |

## 完了の判定

- [ ] 該当する intended focused tests が選択され、pass した。
- [ ] matrix が要求するすべての gate が pass した。
- [ ] `git diff --check` が clean である。
- [ ] staged file list に ignored/generated artifact（`dist`、coverage、`node_modules` 等）がない。
- [ ] contract/product claims が変わったら owner docs を更新し、README の claims を code/E2E に trace した。

外部 release/deploy や GitHub 上の mutation は maintainer の明示承認が必要。
