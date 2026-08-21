# プライバシーポリシー

この文書は、公開サービス [image-compressor-web](https://app.damonge.com/image-compressor-web/) に適用されます。本サービスは、画像をブラウザ内で変換・圧縮する静的アプリです。画像・ファイルデータの扱いと、通常のアクセス解析を分けて説明します。

## 画像・ファイルデータの扱い

- 利用者が選択した JPEG / PNG / WebP は、ブラウザの File API で読み取り、ブラウザ内および Worker で処理します。
- 本アプリには、選択した入力または生成した出力を受け取るアプリのバックエンド、アップロード用エンドポイント、クラウドストレージ、アカウント、データベースはありません。また、それらへ画像・ファイルデータを送る処理もありません。
- ソース、プレビュー、出力はメモリ上の値とブラウザが管理するオブジェクト／オブジェクト URL を使います。入力の差し替え、リセット、画面の破棄などでは、アプリが管理するオブジェクト URL などを解放します。ただし、ブラウザや OS の一般的なキャッシュや一時保存の有無を、本アプリが制御・保証するものではありません。
- 出力は再エンコードし、metadata stripping を適用します。出力の構造検証に失敗した場合は fail closed として、未検証の Blob / 結果を返しません。
- ダウンロードは利用者がダウンロード操作を行った場合にだけ開始します。

## アクセス解析の扱い

本番ホストでは、ホスティング管理の Cloudflare Web Analytics と Rocket Loader が使われる場合があります。Cloudflare Web Analytics は、通常のページ／アクセス／パフォーマンス解析を行います。Rocket Loader はそれとは別の、ホスティング管理による配信・スクリプト読み込みの最適化です。どちらも、ローカルの画像処理とは別です。

解析の対象は、通常のページ／アクセス／パフォーマンスに関するカテゴリです。具体的には、ページビュー・訪問（page views / visits）、host / path / referrer、国、端末・ブラウザ・OS、navigation type、ページ読み込み timing / Core Web Vitals が含まれます。

アプリ独自の custom analytics event は送信しません。選択ファイルの file name、MIME、metadata、content、pixels、bytes を解析データとして送信しません。

Web Analytics の beacon は管理対象スクリプト [`https://static.cloudflareinsights.com/beacon.min.js`](https://static.cloudflareinsights.com/beacon.min.js) から読み込まれ、beacon data は同一 origin の `/cdn-cgi/rum` に送られます。本番配信に伴う通常の HTTP / ネットワークデータは Cloudflare のインフラストラクチャで処理され、Cloudflare のプライバシー条件・ポリシーが適用されます。Cloudflare 側の収集方法と取扱いの詳細は、[Cloudflare Web Analytics About](https://developers.cloudflare.com/web-analytics/about/)、[Data origin and collection](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/)、[Cloudflare Privacy Policy](https://www.cloudflare.com/policies/privacy/) を参照してください。

## 外部リンク

フッターには、同一サイト内の App Hub へのナビゲーションと、X、GitHub への外部リンクがあります。App Hub は同一サイト内のリンクです。本サービスの管理範囲を離れて X または GitHub へ移動した後は、それぞれの外部提供者の利用規約・プライバシーポリシーが適用されます。

## 変更・問い合わせ

このポリシーは、現在の実装とホスティング環境を反映しており、重要なプライバシー変更がある場合に更新します。

問い合わせの連絡先として [GitHub Issues](https://github.com/big-mon/image-compressor-web/issues) を利用できます。
