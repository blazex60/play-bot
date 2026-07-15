<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# legal

## Purpose

利用規約・プライバシーポリシー公開用の静的サイト。npm/Node のビルドパイプラインとは無関係で、Cloudflare Pages の Git integration が `main` への push を検知して `legal/` ディレクトリをそのまま配信する（`../wrangler.jsonc` の `pages_build_output_dir`）。ビルドコマンドは空欄（プレーン HTML/CSS のみ）。

## Key Files

| File | Description |
|------|--------------|
| `index.html` | 法務文書一覧ページ（`/`） |
| `terms.html` | 利用規約（`/terms`） |
| `privacy.html` | プライバシーポリシー（`/privacy`） |
| `styles.css` | 3 ページ共通スタイル |
| `_headers` | Cloudflare Pages が読み込む静的レスポンスヘッダー設定 |

## For AI Agents

### Working In This Directory
- ここは独立した Cloudflare Pages project（`music-bot-legal`）としてデプロイされる。npm scripts・Vite・Fastify のいずれとも連携しない
- 文面を更新したら `main` に push するだけで Cloudflare Pages が自動デプロイする（ビルドステップなし）
- ローカル確認は `npx wrangler pages dev legal --port 8788`

### Testing Requirements
- 自動テストはない。ローカルで `wrangler pages dev` を使って目視確認する

## Dependencies

### External
- Cloudflare Pages（Git integration 経由、`../wrangler.jsonc` で project 設定）

<!-- MANUAL: -->
