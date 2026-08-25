import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import staticFFmpeg from 'ffmpeg-static';

const pExecFile = promisify(execFile);

const FFMPEG_BIN = process.env.FFMPEG_PATH || staticFFmpeg || 'ffmpeg';

export class AutoBypassError extends Error {
  constructor(message, { blocked = false } = {}) {
    super(message);
    this.name = 'AutoBypassError';
    this.blocked = blocked;
  }
}

async function ffRun(args, { timeoutMs = 180_000 } = {}) {
  try {
    return await pExecFile(FFMPEG_BIN, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new AutoBypassError('ffmpeg is not installed on the host.');
    }
    throw err;
  }
}

async function lumaTrack(file, maxSeconds = 20) {
  const args = [
    '-hide_banner', '-nostats',
    '-t', String(maxSeconds),
    '-i', file,
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ];
  const { stderr } = await ffRun(args);
  const track = [];
  let t = null;
  for (const line of stderr.split(/\r?\n/)) {
    const tm = line.match(/pts_time:([0-9.]+)/);
    if (tm) { t = Number(tm[1]); continue; }
    const ym = line.match(/YAVG=([0-9.]+)/);
    if (ym && t !== null) { track.push([t, Number(ym[1])]); t = null; }
  }
  return track;
}

function firstSustainedContent(track, { lo, hi, windowSec }) {
  for (let i = 0; i < track.length; i++) {
    const [t0, y0] = track[i];
    if (y0 <= lo || y0 >= hi) continue;
    let ok = true;
    for (let j = i + 1; j < track.length; j++) {
      const [tj, yj] = track[j];
      if (tj - t0 > windowSec) break;
      if (yj <= lo || yj >= hi) { ok = false; break; }
    }
    if (ok) return t0;
  }
  return null;
}

export async function analyzeVideo(file, { maxSeconds = 20 } = {}) {
  const track = await lumaTrack(file, maxSeconds);
  if (!track.length) return { sceneStart: null, method: 'no-data' };

  let start = firstSustainedContent(track, { lo: 35, hi: 170, windowSec: 0.5 });
  let method = 'strict';
  if (start === null) {
    start = firstSustainedContent(track, { lo: 35, hi: 190, windowSec: 0.5 });
    method = 'wide';
  }
  if (start === null) {
    let lastBlack = null;
    for (const [t, y] of track) {
      if (y <= 35 && t < 3.0) lastBlack = t;
    }
    if (lastBlack !== null) {
      start = lastBlack + 1 / 24;
      method = 'black';
    }
  }
  if (start === null) return { sceneStart: null, method: 'unknown' };
  return { sceneStart: Math.max(0, start), method };
}

export async function trimVideo(srcPath, startSec) {
  const outPath = join(tmpdir(), `autobypass-${randomBytes(8).toString('hex')}.mp4`);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', Number(startSec).toFixed(3),
    '-i', srcPath,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y', outPath,
  ];
  try {
    await ffRun(args, { timeoutMs: 300_000 });
    return outPath;
  } catch (err) {
    await unlink(outPath).catch(() => {});
    throw err;
  }
}
