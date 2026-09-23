# テスラ スーパーチャージャー充足度マップ（日本）

日本のテスラ スーパーチャージャー（SC）の配置を人口分布と重ね、**人口のわりにSCが少ない地域**を可視化する静的Webマップです。GitHub Pages（`docs/`）で公開しています。

## 表示内容

### 行政区別（手法A）
都道府県／市区町村／市区町村（政令市は区）ごとに次の指標を塗り分けます。

| 指標 | 内容 |
|---|---|
| 人口10万人あたりSC数 | 区域内のSC数 ÷ 人口 × 10万 |
| 30km圏アクセス | 2SFCA法。各SCの容量を半径30km圏の人口で割り、住民から30km以内のSCについて合計（1kmメッシュ人口で加重平均）。隣接自治体のSCも反映 |
| 最寄りSCまでの平均距離 | 住民（1kmメッシュ）から最寄りSCまでの直線距離の人口加重平均 |
| SC数 | 区域内のSC数 |

数え方（サイト数／ストール数）、対象（営業中のみ／計画・建設中を含む）を切り替えられます。サイドパネルに「人口のわりに少ない」地域のランキングを表示し、人口規模で絞り込めます。

### 1kmメッシュ（手法B）
1kmメッシュ人口とSCを同じ幅（σ = 10 / 30 / 50 km）のガウスカーネルで平滑化し、

```
充足率 = 実際のSC密度 ÷ (平滑化人口密度 × 全国SC数 / 全国人口)
```

を表示します。1 未満は人口比どおりの配置に比べてSCが少ない地域です。人口密度の平滑化は事前計算、SC密度はブラウザで計算しています。

## データ出典
- SC：[supercharge.info](https://supercharge.info/)（有志によるデータベース。計画中サイトでストール数未定のものは営業中サイトの中央値で推定）
- 人口：令和2年国勢調査（総務省統計局）都道府県・市区町村別の主な結果、地域メッシュ統計（3次メッシュ）— [e-Stat](https://www.e-stat.go.jp/)
- 行政区域：[国土数値情報 行政区域データ](https://nlftp.mlit.go.jp/ksj/)（国土交通省）を加工した [smartnews-smri/japan-topography](https://github.com/smartnews-smri/japan-topography)（2021年1月1日時点）を加工
- 背景地図：[国土地理院 淡色地図](https://maps.gsi.go.jp/development/ichiran.html)

## データ再生成

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
cd pipeline
..\.venv\Scripts\python run_all.py   # docs/data/* を再生成（mapshaper 用に npx が必要）
```

| スクリプト | 役割 |
|---|---|
| `pipeline/fetch_sc.py` | supercharge.info から日本のSCを取得 → `docs/data/sc.geojson` |
| `pipeline/fetch_inputs.py` | 境界・市区町村人口・1kmメッシュ人口を取得 |
| `pipeline/build_admin.py` | 手法Aの集計 → `docs/data/admin_stats.json` |
| `pipeline/build_mesh.py` | 手法Bの人口平滑化 → `docs/data/mesh.bin`, `mesh_meta.json` |
| `pipeline/run_all.py` | 上記と TopoJSON 生成（`docs/data/boundaries.topojson`）を一括実行 |

ローカル確認：

```powershell
cd docs; python -m http.server 8765
# 別ターミナルで（Microsoft Edge を使用）
.\.venv\Scripts\python tools\smoke_test.py http://localhost:8765/ screenshots
```

## 留意点
- SCは長距離移動時の経路充電が主用途のため、人口だけで需要を表すものではありません（高速道路網・観光需要・EV保有台数は未反映）。
- 距離は直線距離です。
- 福島県双葉町（2020年国勢調査人口なし）と北方領土は集計対象外です。
