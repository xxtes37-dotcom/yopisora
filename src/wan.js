/**
 * WAN 3.0 video via the self-hosted generation proxy.
 *
 * Async task flow:
 *   1. POST /api/generate  { model, input:{prompt, img_url?}, parameters:{duration, size} } -> task id
 *   2. GET  /api/status/{task_id}  until task_status SUCCEEDED / FAILED
 *   3. Download the mp4 from output.video_url (a signed OSS URL)
 *
 * 720p is fixed (1280*720 / 720*1280), audio is always on.
 */
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = process.env.WAN_BASE_URL || 'http://47.84.12.128:9000';
const DEFAULT_MODEL = 'wan3.0-video';

export const WAN_MODEL = DEFAULT_MODEL;
export const WAN_DURATIONS = [5, 10, 15, 20, 25, 30];
export const WAN_DEFAULT_DURATION = 10;
export const WAN_RATIOS = ['16:9', '9:16'];
export const WAN_DEFAULT_RATIO = '16:9';
export const WAN_RESOLUTIONS = ['480p', '720p'];
export const WAN_DEFAULT_RESOLUTION = '720p';
export const WAN_MAX_IMAGES = 3;

const SIZE_BY_RATIO = {
  '16:9': { '480p': '864*480', '720p': '1280*720' },
  '9:16': { '480p': '480*832', '720p': '720*1280' },
};

const OSS_PUBLIC_BASE = process.env.WAN_OSS_PUBLIC_BASE || 'https://hhtestforintl.oss-ap-southeast-1.aliyuncs.com/happyhorse';

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000; // 20 min
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const BLOCK_RE = /sensitive|privacy|real person|policy|violat|prohibit|nsfw|copyright|risk|illegal|moderat|inappropriate/i;

export class WanError extends Error {
  constructor(message, { status, code, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'WanError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.blocked = Boolean(blocked);
    this.timedOut = Boolean(timedOut);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WanClient {
  #base;
  #model;
  #fetch;

  constructor({ baseUrl, model, fetchImpl } = {}) {
    this.#base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#model = model ?? DEFAULT_MODEL;
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  async #fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await this.#fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  // ─── Reference upload ──────────────────────────────────────────────────────
  // Mirrors the web app: PUT the raw bytes to /api/oss/happyhorse/{date}/{time}_{rand}/inputs/image_{i}.{ext}
  // then reference the public OSS mirror of that key in input.media.
  async uploadReference(attachment, index) {
    const url = attachment.url ?? attachment;
    const name = attachment.name || 'image.png';
    const extMatch = name.match(/\.([a-z0-9]{2,5})$/i);
    const ext = (extMatch ? extMatch[1] : 'png').toLowerCase();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    let bytes;
    try {
      const resp = await this.#fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new WanError('Could not fetch a reference image.');
      bytes = Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    clearTimeout(timer);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    const rand = `t${Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')}`;
    const key = `${date}/${time}_${rand}/inputs/image_${index}.${ext}`;

    const upCtrl = new AbortController();
    const upTimer = setTimeout(() => upCtrl.abort(), 120_000);
    try {
      const resp = await this.#fetch(`${this.#base}/api/oss/happyhorse/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': attachment.contentType || 'image/png' },
        body: bytes,
        signal: upCtrl.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        console.error(`[wan.uploadReference] HTTP ${resp.status}: ${t.slice(0, 300)}`);
        throw new WanError('Could not upload a reference image.');
      }
    } catch (err) {
      clearTimeout(upTimer);
      throw err;
    }
    clearTimeout(upTimer);

    return { type: 'reference_image', url: `${OSS_PUBLIC_BASE}/${key}` };
  }

  // ─── Create task ───────────────────────────────────────────────────────────
  async createTask({ prompt, duration, ratio, resolution, images = [] }) {
    const size = SIZE_BY_RATIO[ratio]?.[resolution] ?? SIZE_BY_RATIO[ratio]?.[WAN_DEFAULT_RESOLUTION] ?? '1280*720';
    const input = { prompt };
    if (images.length) input.media = images;
    const body = {
      model: this.#model,
      input,
      parameters: { duration, size },
    };

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(3000 * attempt);

      let resp;
      try {
        resp = await this.#fetchWithTimeout(`${this.#base}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = new WanError('Could not start video generation. Please try again.');
        console.warn(`[wan.createTask] network error (attempt ${attempt + 1}/3): ${err?.message ?? err}`);
        continue;
      }

      const txt = await resp.text().catch(() => '');
      let data = null; try { data = JSON.parse(txt); } catch { /* */ }

      const taskId = data?.output?.task_id;
      if (resp.ok && taskId) return { taskId };

      const code = data?.error?.code || data?.code || '';
      const msg = data?.error?.message || data?.message || '';
      console.error(`[wan.createTask] HTTP ${resp.status} code=${code}: ${txt.slice(0, 500)}`);

      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new WanError('The generation service is busy right now. Please try again in a minute.', { status: resp.status, code, body: txt, blocked: true });
        continue;
      }
      throw new WanError(
        msg && msg.length <= 300 && !BLOCK_RE.test(`${code} ${msg}`)
          ? msg
          : 'Could not start video generation. Please try again.',
        { status: resp.status, code, body: txt, blocked: BLOCK_RE.test(`${code} ${msg}`) },
      );
    }
    throw lastErr ?? new WanError('Could not start video generation. Please try again.');
  }

  // ─── Poll ──────────────────────────────────────────────────────────────────
  async waitForTask(taskId, { intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS, onUpdate } = {}) {
    const deadline = Date.now() + timeoutMs;
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    let lastStatus = null;
    let fails = 0;

    while (Date.now() < deadline) {
      let resp;
      try {
        resp = await this.#fetchWithTimeout(`${this.#base}/api/status/${encodeURIComponent(taskId)}`);
      } catch (err) {
        fails += 1;
        console.warn(`[wan.waitForTask] poll request failed (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new WanError('Could not check generation status. Please try again.');
        await sleep(intervalMs); continue;
      }

      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        if (resp.status >= 500 || resp.status === 429) {
          fails += 1;
          console.warn(`[wan.waitForTask] transient HTTP ${resp.status} (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
          if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new WanError('Could not check generation status. Please try again.', { status: resp.status, body: t });
          await sleep(intervalMs); continue;
        }
        console.error(`[wan.waitForTask] HTTP ${resp.status}: ${t.slice(0, 300)}`);
        throw new WanError('Could not check generation status. Please try again.', { status: resp.status, body: t });
      }

      fails = 0;
      const data = await resp.json();
      const status = data?.output?.task_status;
      if (status !== lastStatus) { lastStatus = status; if (onUpdate) onUpdate(status); }

      if (status === 'SUCCEEDED') {
        const url = data.output?.video_url;
        if (!url) throw new WanError('Generation finished but no video URL was returned.', { body: data });
        return { videoUrl: url, raw: data };
      }
      if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED' || status === 'UNKNOWN') {
        const code = data.output?.code || '';
        const msg = data.output?.message || `Generation ${String(status).toLowerCase()}.`;
        console.error(`[wan.waitForTask] ${status} code=${code}: ${msg}`);
        throw new WanError(
          msg && msg.length <= 300 && !BLOCK_RE.test(`${code} ${msg}`)
            ? msg
            : 'Generation failed. Please try again.',
          { code, body: data, blocked: BLOCK_RE.test(`${code} ${msg}`) },
        );
      }
      await sleep(intervalMs);
    }
    throw new WanError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── Download (streamed to disk) ─────────────────────────────────────────────
  async downloadFile(url, { timeoutMs = 180_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const filePath = path.join(os.tmpdir(), `wan-${randomBytes(8).toString('hex')}.mp4`);
    try {
      const resp = await this.#fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new WanError('Could not download the result file.', { status: resp.status });
      const contentType = resp.headers.get('content-type') || 'video/mp4';
      if (resp.body && typeof Readable.fromWeb === 'function') {
        await pipeline(Readable.fromWeb(resp.body), createWriteStream(filePath));
      } else {
        await writeFile(filePath, Buffer.from(await resp.arrayBuffer()));
      }
      const { size } = await stat(filePath);
      return { path: filePath, bytes: size, contentType };
    } catch (err) {
      await unlink(filePath).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
