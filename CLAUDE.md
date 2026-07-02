# CLAUDE.md — music-bot

## 概要

Discord VC で YouTube 音楽をストリーミング再生する Bot。
discord.js v14 + @discordjs/voice + yt-dlp + FFmpeg で構成。LLM・外部 AI API は使用しない。

---

## 開発環境

| 項目 | 内容 |
|---|---|
| Runtime | Node.js >= 20 |
| パッケージ管理 | npm |
| Discord ライブラリ | discord.js v14 + @discordjs/voice |
| 音楽取得 | yt-dlp (child_process.spawn) |
| 音声処理 | FFmpeg |
| デプロイ | Docker Compose |

---

## よく使うコマンド

```bash
npm install
node src/deploy.js      # スラッシュコマンドを Discord に登録
node src/index.js       # Bot 起動
docker compose up --build
```

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/index.js` | Bot エントリーポイント（コマンドロード・イベント処理） |
| `src/sessions.js` | VC セッション共有状態（joinVoiceChannel・GuildQueue・GuildPlayer） |
| `src/player.js` | GuildPlayer（ウォッチドッグ・ループ処理） |
| `src/queue.js` | GuildQueue（LoopMode: OFF/TRACK/QUEUE） |
| `src/search.js` | yt-dlp 連携（検索・メタデータ取得・ストリーム URL 解決） |
| `src/views.js` | 検索結果ボタン UI（ActionRowBuilder） |
| `src/commands/` | 11 個のスラッシュコマンド |
| `src/deploy.js` | スラッシュコマンド登録スクリプト |

---

## 音声実装の詳細

音声関連はすべて `@discordjs/voice` で処理する。`ytdl-core` や他の音声ライブラリは使わない。

### VC 接続 (`src/sessions.js`)

```
joinVoiceChannel({ selfDeaf: true }) → entersState(Ready, 30s)
```

- **`network_mode: host` 必須** — Docker の bridge NAT が UDP をブロックし `entersState(Ready)` がタイムアウトする。`docker-compose.yml` に `network_mode: "host"` を設定すること（Linux 専用、Mac/Windows 不可）
- **`@discordjs/voice` は `^0.19.2` 以上を使うこと** — Discord が 2024年11月に旧暗号化方式（`xsalsa20_poly1305` 系）を廃止し、`aead_xchacha20_poly1305_rtpsize` / `aead_aes256_gcm_rtpsize` が必須になった。0.17.x 以前は接続しても UDP ハンドシェイクが失敗する

### 音声ストリーム (`src/search.js` → `src/player.js`)

```
resolveAudioStream(url)  →  yt-dlp stdout  →  createAudioResource(stream)
```

- **yt-dlp の stdout を直接パイプする** — `yt-dlp --get-url` で URL 文字列を取得して FFmpeg に渡す方式は、googlevideo URL へのアクセスに必要なヘッダーが揃わず音声がストールする。`yt-dlp -o -` で stdout にパイプし、そのまま `createAudioResource` に渡すこと
- **`StreamType.Arbitrary`** — yt-dlp が出力するコンテナ形式（webm/opus、m4a/aac 等）を FFmpeg が自動検出してトランスコードする

### ウォッチドッグ (`src/player.js`)

- **`playbackDuration` の進捗で判定する** — `stateChange` イベントは再生開始時に一度しか発火しないため、それを基準にすると正常再生中でも常に 30 秒で誤発火する。`state.playbackDuration` が 10 秒間隔で増加しているかを確認し、増加が止まった場合のみストールと判定する
- **`#hadError` フラグ** — 音声エラー発生時に TRACK ループモードで同一トラックへ無限リトライしないよう、エラー時は `queue.next({ forceAdvance: true })` で強制スキップする。フラグ値は `next()` を呼ぶ前に退避してからリセットすること（順序が逆だとフラグが無効になる）

---

## 設計上の制約

- **selfDeaf はネイティブ対応** — `joinVoiceChannel({ selfDeaf: true })` を使用
- **AudioPlayerStatus.Idle イベント** — 曲終了後の次曲再生はこのイベントで駆動
- **循環インポート防止** — `sessions.js` が共有状態を管理。`index.js` と `play.js` の双方向依存を排除
- **LLM 不使用** — 外部 AI API は一切使わない

## シークレット管理

- `DISCORD_TOKEN` / `CLIENT_ID` は必ず `.env` に書く
- ソースコードにシークレットを書かない
