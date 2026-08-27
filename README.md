# Yopisora — video bot

A single-server Discord bot: `/flux-3`, `/sd2`, `/sd2-5` and `/wan-3`.

## Commands

`/flux-3` — FLUX 3
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20 seconds
- `ratio` — 16:9 (default), 9:16

`/sd2` — Seedance 2.0
- `prompt` (required)
- `duration` — 5, 10 (default), 15 seconds
- `resolution` — 480p, 720p (default)
- `ratio` — 16:9 (default), 9:16
- `img1`–`img3` — optional reference images
- `vid1` — optional reference video

`/sd2-5` — Seedance 2.5
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20, 25, 30 seconds
- `resolution` — 480p, 720p (default)
- `ratio` — 16:9 (default), 9:16, 21:9
- `img1`–`img3` — optional reference images
- `vid1` — optional reference video

`/wan-3` — WAN 3.0
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20, 25, 30 seconds
- `ratio` — 16:9 (default), 9:16
- `resolution` — 480P (832x480 / 480x832), 720P (1280x720 / 720x1280, default) —
  native output, no upscaling
- `img1`–`img3` — optional reference images (passed as reference images, not a
  first frame)
- Audio is always on. Renders over 99% of the server upload limit are
  compressed slightly (to ~98%) so they still attach.

## Setup

1. `npm install`
2. Fill `.env`: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`
   (`/sd2`, `/sd2-5` and `/wan-3` need no API key)
3. `npm run register`
4. `npm start`

## Notes

- Generations are persisted to `GEN_JOB_STORE_DIR` the moment they're submitted,
  so a restart / OOM-kill / deploy mid-render resumes and delivers on next boot.
  Point it at a persistent volume if your host wipes the working dir on restart.
- The result video is streamed to disk and attached from disk to keep memory low.
- Reference images/videos are uploaded to the generation proxy and passed as
  reference media (never as a first frame).
- Provider-specific error reasons are shown to the user (e.g. reference video
  duration limits, copyright / content-policy blocks) with backend identifiers
  redacted; full raw errors go to console only.
- `npm start` caps the V8 heap (`--max-old-space-size=640`) for small (~1 GB)
  hosts; lower it to `512` if needed.
