/**
 * WAN3.0 video generation client — Alibaba Cloud Model Studio (DashScope).
 *
 * Async flow:
 *   1. POST /services/aigc/video-generation/video-synthesis  (X-DashScope-Async: enable) -> task_id
 *   2. GET  /tasks/{task_id}  until SUCCEEDED / FAILED
 *   3. Download the result mp4 from the returned video_url (valid 24h)
 *
 * Auth is a single Bearer API key (DASHSCOPE_API_KEY). No per-request accounts.
 * Reference images/videos are passed as public URLs in input.media, so Discord
 * attachment URLs go straight through — no upload step.
 */
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';
const MODEL = 'wan3.0-video';

// ─── Public constants ────────────────────────────────────────────────────────
export const WAN_MODEL = MODEL;
export const WAN_DURATIONS = [5, 10, 15, 20, 25, 30];
export const WAN_DEFAULT_DURATION = 10;
export const WAN_RATIOS = ['16:9', '9:16'];
export const WAN_DEFAULT_RATIO = '16:9';
export const WAN_RESOLUTIONS = ['480p', '720p'];
export const WAN_DEFAULT_RESOLUTION = '720p';
export const WAN_MAX_IMAGES = 4;
export const WAN_MAX_VIDEOS = 1;

export const DEFAULT_POLL_INTERVAL_MS = 15_000; // docs recommend ~15s
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000; // 20 min
export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const UPLOAD_REQUEST_TIMEOUT_MS = 180_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

// Content-moderation / policy failures -> amber "blocked" rather than red "error".
const BLOCK_RE = /inappropriate|sensitive|policy|violat|green|risk|data.?inspection|content.?moderat|prohibit|nsfw|illegal/i;

// ─── Error ───────────────────────────────────────────────────────────────────
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
const apiResolution = (r) => (String(r).toLowerCase() === '480p' ? '480P' : '720P');

// Surface the provider's real reason to the user when it's short and clean;
// otherwise a generic line. Full detail always goes to the console.
function userMessage(code, msg, fallback) {
  const m = (msg || '').trim();
  if (m && m.length <= 280) return m;
  return fallback;
}

// ─── Client ──────────────────────────────────────────────────────────────────
export class WanClient {
  #key;
  #base;
  #fetch;

  constructor({ apiKey, baseUrl, fetchImpl } = {}) {
    this.#key = apiKey ?? process.env.DASHSCOPE_API_KEY;
    this.#base = (baseUrl ?? process.env.DASHSCOPE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#fetch = fetchImpl ?? globalThis.fetch;
    if (!this.#key) throw new WanError('DASHSCOPE_API_KEY is not set.');
  }

  async #fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.#fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Create task ───────────────────────────────────────────────────────────
  /**
   * @param {{prompt:string, duration:number, ratio:string, resolution:string,
   *          references?:Array<{type:'image'|'video', url:string}>}} opts
   * @returns {Promise<{taskId:string, status:string}>}
   */
  async createTask({ prompt, duration, ratio, resolution, references = [] }) {
    const input = { prompt };
    if (references.length) {
      input.media = references.map((r) => ({
        type: r.type === 'video' ? 'reference_video' : 'reference_image',
        url: r.url,
      }));
    }

    const body = {
      model: MODEL,
      input,
      parameters: {
        resolution: apiResolution(resolution),
        ratio,
        duration,
        prompt_extend: false, // disabled per request
        audio: true,          // always on
        watermark: false,     // always off, no toggle
      },
    };

    // Transient network / 429 / 5xx get a couple of retries; auth, param and
    // moderation errors fail fast.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(3000 * attempt);

      let resp;
      try {
        resp = await this.#fetchWithTimeout(
          `${this.#base}/api/v1/services/aigc/video-generation/video-synthesis`,
          {
            method: 'POST',
            headers: {
              'X-DashScope-Async': 'enable',
              Authorization: `Bearer ${this.#key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
        );
      } catch (err) {
        lastErr = new WanError('Could not start video generation. Please try again.', {});
        console.warn(`[createTask] network error (attempt ${attempt + 1}/3): ${err?.message ?? err}`);
        continue;
      }

      const txt = await resp.text().catch(() => '');
      let data = null;
      try { data = JSON.parse(txt); } catch { /* non-JSON */ }

      if (resp.ok && data?.output?.task_id) {
        return { taskId: data.output.task_id, status: data.output.task_status };
      }

      const code = data?.code || data?.output?.code || '';
      const msg = data?.message || data?.output?.message || '';
      console.error(`[createTask] HTTP ${resp.status} code=${code}: ${txt.slice(0, 500)}`);

      // Transient server-side -> retry
      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new WanError('The generation service is busy right now. Please try again in a minute.', {
          status: resp.status, code, body: txt, blocked: true,
        });
        continue;
      }

      // Everything else is terminal.
      throw new WanError(
        userMessage(code, msg, 'Could not start video generation. Please try again.'),
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
    let consecutiveFailures = 0;

    while (Date.now() < deadline) {
      let resp;
      try {
        resp = await this.#fetchWithTimeout(`${this.#base}/api/v1/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${this.#key}` },
        });
      } catch (err) {
        consecutiveFailures += 1;
        console.warn(`[waitForTask] poll request failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new WanError('Could not check generation status. Please try again.');
        }
        await sleep(intervalMs);
        continue;
      }

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        if (resp.status >= 500 || resp.status === 429) {
          consecutiveFailures += 1;
          console.warn(`[waitForTask] transient HTTP ${resp.status} (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${txt.slice(0, 300)}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            throw new WanError('Could not check generation status. Please try again.', { status: resp.status, body: txt });
          }
          await sleep(intervalMs);
          continue;
        }
        console.error(`[waitForTask] HTTP ${resp.status}: ${txt.slice(0, 500)}`);
        throw new WanError('Could not check generation status. Please try again.', { status: resp.status, body: txt });
      }

      consecutiveFailures = 0;
      const data = await resp.json();
      const out = data.output ?? {};
      const status = out.task_status;

      if (status !== lastStatus) {
        lastStatus = status;
        if (onUpdate) onUpdate(out);
      }

      if (status === 'SUCCEEDED') {
        if (!out.video_url) {
          throw new WanError('Generation completed but no video URL was returned.', { body: data });
        }
        return { status, videoUrl: out.video_url, raw: out };
      }

      if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
        const code = out.code || '';
        const msg = out.message || `Generation ${String(status).toLowerCase()}.`;
        console.error(`[waitForTask] ${status} code=${code}: ${msg}`);
        throw new WanError(
          userMessage(code, msg, 'Generation failed. Please try again.'),
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
      if (!resp.ok) {
        throw new WanError('Could not download the result file.', { status: resp.status });
      }
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

// ─── Failure classification ──────────────────────────────────────────────────
export function classifyWanFailure(err) {
  if (err instanceof WanError) return { blocked: err.blocked, message: err.message };
  return { blocked: false, message: err?.message || 'An unexpected error occurred.' };
}
