# Yopisora — video bot

A single-server Discord bot: `/flux-3`, `/sd2`, `/autobypass` and `/wan-3`.

## Commands

`/flux-3` — FLUX 3
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20 seconds
- `ratio` — 16:9 (default), 9:16

`/sd2` — Seedance 2.0
- `prompt` (required)
- `duration` — 5, 10 (default), 15 seconds
- `resolution` — 480p, 720p (default)
- `ratio` — 16:9 (default), 9:16, 21:9, 4:3
- `img1`–`img3` — optional reference images
- `vid1` — optional reference video

`/autobypass` — fires 4 Seedance 2.0 renders (15s • 16:9 • 480p) of the prompt
template with `videointro.mov` attached as the reference video, waits for every
render, then uses ffmpeg to judge which render has the least intro (the scene
cut point is detected from the black gap / fade / crossfade after the intro)
and delivers that render trimmed to the scene.
- `prompt` (required) — the scene the video should cut to after the intro
- If every render is a content violation: "All videos were content violation,
  try again".
- The batch is persisted right after the submits, so a restart mid-batch
  resumes on next boot (re-polls every render, judges, delivers).

`/wan-3` — WAN 3.0 (audio always on)
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20, 25, 30 seconds
- `ratio` — 16:9 (default), 9:16
- `resolution` — 480p, 720p (default)
- `img1`–`img3` — optional reference images (uploaded to the proxy's OSS and
  passed as `input.media` reference images, like the web app does)

## Setup

1. `npm install`
2. Fill `.env`: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`,
   `ARK_API_KEY` (used by `/sd2` and `/autobypass`). `/wan-3` needs no key —
   set `WAN_BASE_URL` to override the proxy address.
3. `npm run register`
4. `npm start`

`ffmpeg` must be on the host `PATH` (or set `FFMPEG_PATH`) — `/autobypass`
needs it for scene detection and trimming.

## Notes

- `videointro.mov` (project root) is uploaded once per bot session and its
  Discord attachment URL is reused as the reference video. Override with
  `AUTOBYPASS_REF_VIDEO_URL`, or point `AUTOBYPASS_INTRO_PATH` elsewhere.
- Reference images/videos are passed to ARK as their Discord attachment URLs —
  no upload step.
- Generations are persisted to `GEN_JOB_STORE_DIR` the moment they're submitted,
  so a restart / OOM-kill / deploy mid-render resumes and delivers on next boot.
  Point it at a persistent volume if your host wipes the working dir on restart.
- The result video is streamed to disk and attached from disk to keep memory low.
- `npm start` caps the V8 heap (`--max-old-space-size=640`) for small (~1 GB)
  hosts; lower it to `512` if needed.
