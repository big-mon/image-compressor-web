# Development and verification

**Audience / trigger:** setup、test selection、BASE_PATH 配信、Chromium E2E、package/toolchain、または completion gate を確認する人は読む。変換契約や stale-request の意味は [architecture.md](architecture.md) が owner である。

## Prerequisites and dependency setup

Runtime、package manager、script の正確な要件と実行内容は [package.json](../package.json) の `engines`、`packageManager`、`scripts` が authority である。依存の解決結果と lock integrity は [pnpm-lock.yaml](../pnpm-lock.yaml) にあり、package.json にない package を手作業で足さない。

Dependency setup (when needed):

依存関係が未導入の場合、package/lock/toolchain を変更した場合、または clean/release verification が必要な場合に実行する。read-only/docs-only task では、リポジトリに入っただけで install する必要はない。

```sh
pnpm install --frozen-lockfile
```

これは lockfile を変更せずに install する。toolchain/lockfile の変更、または環境差を疑う場合は、isolated clean checkout/store を使い、別 repo の `node_modules` を link せずにこの command を通す。npm、yarn、package-lock はこの repo の install authority ではない。

Local development:

```sh
pnpm run dev
```

Vite の dev server で UI を開く。[README.md](../README.md) は product/scope の quick start、[docs/privacy.md](privacy.md) は user-facing privacy policy、[architecture.md](architecture.md) は technical transform/privacy boundary を所有する。

## Scripts by intent

script の composition は package.json が owner。ここでは「いつ使うか」だけを記す。

| command | intent |
| --- | --- |
| `pnpm run dev` | local UI を Vite で起動する |
| `pnpm test` | include 設定に入る unit/helper tests を一括実行する |
| `pnpm test <path>` | Vitest の focused run。対象 file が本当に選ばれたことを出力で確認する |
| `pnpm test:watch` | 反復編集用の watch mode |
| `pnpm run lint` | ESLint の static check |
| `pnpm run typecheck` | TypeScript project build の型検査 |
| `pnpm run build` | production bundle を作る。BASE_PATH の確認にも使う |
| `pnpm run test:e2e` | build 済み `dist` を実 Chrome/CDP で受け入れ検証する |

### Focused test selection

pnpm の script forwarding と Vitest の positional path を使う。現在の pnpm では `--` を挟まない。

```sh
pnpm test src/image/geometry.test.ts
```

出力の test file と件数が `src/image/geometry.test.ts` の意図した選択になっていることを確認する。verbose な確認が必要なら、同じ path を保ったまま Vitest option を forward する。

```sh
pnpm test --reporter=verbose src/image/geometry.test.ts
```

`pnpm test -- src/image/geometry.test.ts` はこの repo の pnpm/Vitest 組み合わせでは `vitest run -- src/...` となり、focused selector ではなく全 test file を実行する。対象 file の選択確認を省略しない。

変更に対応する module contract と evidence は [architecture.md](architecture.md) を参照し、minimum gate の選択は [AGENTS.md](../AGENTS.md) の verification matrix に従う。focused test の selector と forwarding の確認はこの節の手順に従う。

## Selecting verification

変更 class に必要な gate は [AGENTS.md](../AGENTS.md) の `Change → minimum verification` matrix から選ぶ。この文書が所有するのは、focused test の選択確認、clean/frozen setup、`BASE_PATH` build、Chromium E2E の実行方法だけである。clean-state が必要な場合は、isolated clean checkout/store で `pnpm install --frozen-lockfile` を実行する。matrix の full command set はここに重複させない。

## BASE_PATH and Chromium E2E

Vite の `base` と static harness は `/` 以外の subpath を想定できる。`BASE_PATH` は leading/trailing slash を含む値にし、build と E2E に同じ値を渡す。

```sh
BASE_PATH=/image-compressor-web/ pnpm run build
BASE_PATH=/image-compressor-web/ pnpm run test:e2e
```

E2E prerequisites:

- 先に `dist/index.html` を BASE_PATH 付きで build する。
- default の Chrome executable は `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。別の Chrome/Chromium は `CHROME_PATH` で override する。
- harness は built static server を loopback に立て、random port の same-origin surface だけを許可する。実 Worker asset、SPA fallback、browser console/exceptions、network、preview pixel、download bytes を観測する。
- JPEG fixture は EXIF orientation 6 と EXIF/GPS/ICC/XMP/IPTC/Photoshop/comment を含む。E2E は decode 後の normalized dimensions、final-orientation transform、metadata-free JPEG download を検査する。
- 実行中に作る Chrome profile、download、fixture などの一時リソースは harness の `finally` cleanup で削除される。失敗時も cleanup が走る前提で、成果物を証拠として残す設計ではない。

`CHROME_PATH` の例:

```sh
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" BASE_PATH=/image-compressor-web/ pnpm run test:e2e
```

この acceptance harness は Chrome v1 の証拠であり、Safari/Firefox の互換性を保証しない。

## Public metadata and discovery

`index.html` が公開ページの title、description、absolute canonical を所有する。root の `robots.txt` と sitemap は App Hub が所有し、この subpath では追加しない。SEO は user-first とし、[title links](https://developers.google.com/search/docs/appearance/title-link)、[snippets](https://developers.google.com/search/docs/appearance/snippet)、[canonicalization](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)、[spam policies](https://developers.google.com/search/docs/essentials/spam-policies) に従う。hidden text/links、keyword stuffing、doorway variants、推測的な rich-result markup は追加しない。

## Troubleshooting

- **Chrome executable not found:** default path を確認し、実行可能ファイルの絶対パスを `CHROME_PATH` に設定して再実行する。
- **loopback server が EPERM:** 実ブラウザ E2E を実行できる host environment から `pnpm run test:e2e` を実行する。mock server、mock Worker、unit-only の置換では network/static/Worker acceptance を証明できない。
- **pnpm executable warning:** pnpm 実行時に環境の mise が `MODULE_TYPELESS` 系 warning を出しても、command の exit code と project の test/build result を基準にする。warning を理由に package/config を変更しない。

## Current automation truth

この repo には GitHub Actions がない。CI が追加されるまで、AGENTS.md の verification matrix に従う local gate と実行結果が authoritative であり、CI coverage は記載しない。

## Completion

完了時は [AGENTS.md](../AGENTS.md) の completion checklist に戻る。
