# Yopisora — WAN 3.0 video bot

A single-server Discord bot that generates video with **WAN 3.0** (Alibaba Cloud
Model Studio / DashScope).

## Commands

`/wan-3` — WAN 3.0 (Alibaba Cloud Model Studio, your paid key)
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20, 25, 30 seconds
- `ratio` — 16:9 (default), 9:16
- `resolution` — 480p, 720p (default)
- `img1`–`img4` — optional reference images
- `vid1` — optional reference video

`/flux-3` — FLUX 3 (Synthesia AI Playground, free disposable accounts)
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20 seconds
- `ratio` — 16:9 (default), 9:16

`/sd2` — Seedance 2.0 (Volcengine ARK, your ARK key)
- `prompt` (required)
- `duration` — 5, 10 (default), 15 seconds
- `resolution` — 480p, 720p (default)
- `ratio` — 16:9 (default), 9:16, 21:9, 4:3
- `img1`–`img3` — optional reference images
- `vid1` — optional reference video

Set `ARK_API_KEY` (and `ARK_BASE_URL`) in `.env` for `/sd2`. Reference images/videos
are passed to ARK as their Discord attachment URLs (no upload). `/flux-3` needs no
key — it creates a throwaway Synthesia account per run.

## Setup

1. `npm install`
2. Fill `.env`:
   - `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`
   - `DASHSCOPE_API_KEY` — your Model Studio key
   - `DASHSCOPE_BASE_URL` — `https://dashscope.aliyuncs.com` (mainland) or
     `https://dashscope-intl.aliyuncs.com` (international), matching your key
3. `npm run register` — registers `/wan-3` in your server
4. `npm start`

## Notes

- Reference images/videos are passed to WAN as their Discord attachment URLs —
  no upload step.
- Generations are persisted to `GEN_JOB_STORE_DIR` the moment they're submitted,
  so a restart / OOM-kill / deploy mid-render resumes and delivers on next boot.
  Point it at a persistent volume if your host wipes the working dir on restart.
- The result video is streamed to disk and attached from disk to keep memory low.
- `npm start` caps the V8 heap (`--max-old-space-size=640`) for small (~1 GB)
  hosts; lower it to `512` if needed.
