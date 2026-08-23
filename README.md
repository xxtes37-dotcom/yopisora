# Yopisora — Seedance 2.5 + Seedance 2.0 Fast Discord Bot

A Discord bot exposing two video generation commands:

- **`/sd2-5`** — Seedance 2.5 video. 480p, 5 or 10 seconds, audio always on.
  Up to 4 reference images and 1 reference video.
- **`/sd2fast`** — Seedance 2.0 Fast video. 720p, 5/10/15 seconds, audio always on.
  Up to 3 reference images and 1 reference video.

Both commands create a fresh disposable account per request — no API keys or
persisted credentials needed.

## Commands

### `/sd2-5` — Seedance 2.5

| Option | Type | Notes |
| --- | --- | --- |
| `prompt` | string, **required** | What the video should show. |
| `duration` | integer | 5 or 10 seconds (default 10). |
| `aspect` | string | `16:9` (default) or `9:16`. |
| `img1`–`img4` | attachment | Reference images (up to 4, optional). |
| `vid1` | attachment | Reference video — MP4/MOV (optional). |

Resolution is capped at 480p. Audio is always generated — no option to disable.

### `/sd2fast` — Seedance 2.0 Fast

| Option | Type | Notes |
| --- | --- | --- |
| `prompt` | string, **required** | What the video should show. |
| `duration` | integer | 5, 10 (default), or 15 seconds. |
| `aspect` | string | `16:9` (default) or `9:16`. |
| `img1`–`img3` | attachment | Reference images (up to 3, optional). |
| `vid1` | attachment | Reference video — MP4/MOV (optional). |

Audio is always generated — no option to disable.

## Quick start

Fill in `.env` (Discord token, client ID, guild ID). From this folder:

```bash
npm install
npm run register    # one time — registers /sd2-5 and /sd2fast
npm start           # run the bot
```

## How the flow works

Each command:

1. Defers the interaction (user sees "thinking…").
2. Registers a fresh disposable account.
3. (If references) Uploads each reference file.
4. Submits the video generation request.
5. Polls the generation status until COMPLETED or FAILED.
6. Downloads the result video.
7. Edits the anchor embed to a "done" card.
8. Replies to the anchor with the MP4 attached and `@you` ping.

Safety/policy blocks show an amber embed. Genuine errors show a red embed.
No error message exposes the upstream provider.

**Discord 15-minute interaction expiry:** The bot grabs the anchor message
from the first `editReply` and uses `anchor.edit()` / `anchor.reply()` for
all subsequent operations.

## Configuration (`.env`)

```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...                 # single-server lock

GEN_POLL_INTERVAL_MS=5000            # generation poll interval
GEN_VIDEO_TIMEOUT_MS=600000          # 10 min video timeout
GEN_MAX_CONCURRENT_PER_USER=3        # per-user concurrency limit
```

## Layout

```
src/
  bot.js        Discord client + /sd2-5 and /sd2fast handlers
  boxverse.js   API client (account creation, upload, generation, polling)
  register.js   registers the two guild slash commands
  slots.js      per-user concurrency
```
