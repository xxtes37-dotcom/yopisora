/**
 * Generation API client.
 *
 * Creates disposable accounts (no email verification needed), then drives
 * video generation through the API. Each generation gets a fresh account.
 *
 * Flow:
 *   1. Register with a random email + password → get accessToken immediately
 *   2. (Optional) Upload reference images/videos via multipart POST
 *   3. POST /studio/videos with model, prompt, params, references
 *   4. Poll GET /studio/videos/{id} until COMPLETED or FAILED
 *   5. Download the result video from videoUrl
 *
 * Auth is Bearer token in the Authorization header.
 */

import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const API_BASE = 'https://toproute.boxverse.ai';

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  Origin: 'https://toproute.boxverse.ai',
  Referer: 'https://toproute.boxverse.ai/studio',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
};

// ─── Public constants ─────────────────────────────────────────────────────

/** seedance-2.5: 480p or 720p, 5-30 seconds, audio always on. */
export const SD25_MODEL = 'byteplus/seedance-2.5';
export const SD25_DURATIONS = [5, 10, 15, 20, 25, 30];
export const SD25_DEFAULT_DURATION = 10;
export const SD25_RATIOS = ['16:9', '9:16'];
export const SD25_DEFAULT_RATIO = '16:9';
export const SD25_RESOLUTIONS = ['720p', '480p'];
export const SD25_DEFAULT_RESOLUTION = '720p';
export const SD25_SIZES = {
  '720p': { '16:9': '1280x720', '9:16': '720x1280' },
  '480p': { '16:9': '864x480', '9:16': '480x864' },
};
export const SD25_MAX_IMAGES = 4;
export const SD25_MAX_VIDEOS = 1;

/** seedance-2.0-fast: 720p, 5/10/15 seconds, audio always on. */
export const SD2FAST_MODEL = 'byteplus/seedance-2.0-fast';
export const SD2FAST_DURATIONS = [5, 10, 15];
export const SD2FAST_DEFAULT_DURATION = 10;
export const SD2FAST_RATIOS = ['16:9', '9:16'];
export const SD2FAST_DEFAULT_RATIO = '16:9';
export const SD2FAST_SIZES = { '16:9': '1280x720', '9:16': '720x1280' };
export const SD2FAST_MAX_IMAGES = 3;
export const SD2FAST_MAX_VIDEOS = 1;

/** seedance-2.0: 480p, 5/10/15 seconds, audio always on. */
export const SD2_MODEL = 'byteplus/seedance-2.0';
export const SD2_DURATIONS = [5, 10, 15];
export const SD2_DEFAULT_DURATION = 10;
export const SD2_RATIOS = ['16:9', '9:16'];
export const SD2_DEFAULT_RATIO = '16:9';
export const SD2_SIZES = { '16:9': '864x480', '9:16': '480x864' };
export const SD2_MAX_IMAGES = 3;
export const SD2_MAX_VIDEOS = 1;

/** Polling defaults. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 600_000;

/**
 * Per-request network timeout. Without this a single hung socket wedges the
 * whole poll loop forever and the overall generation deadline never gets a
 * chance to fire. 45s is generous for a JSON status check.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
/** Reference uploads can be tens of MB, so they get a longer leash. */
const UPLOAD_REQUEST_TIMEOUT_MS = 180_000;
/** How many back-to-back poll failures we tolerate before giving up. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

// ─── Error ────────────────────────────────────────────────────────────────

export class BoxError extends Error {
  constructor(message, { status, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'BoxError';
    this.status = status;
    this.body = body;
    this.blocked = Boolean(blocked);
    // Timeouts are terminal, not transient — they must never be retried and
    // they get their own user-facing message.
    this.timedOut = Boolean(timedOut);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORDS = [
  'Purple', 'Crimson', 'Azure', 'Golden', 'Silver', 'Emerald', 'Ruby', 'Onyx',
  'Tiger', 'Wolf', 'Dragon', 'Eagle', 'Fox', 'Snake', 'Lion', 'Bear',
  'Falcon', 'Hawk', 'Raven', 'Cobra', 'Panther', 'Viper', 'Storm', 'Blaze',
  'Thunder', 'Frost', 'Shadow', 'Crystal', 'Phoenix', 'Comet', 'Nebula', 'Orbit',
  'Quantum', 'Pixel', 'Cipher', 'Vector', 'Matrix', 'Nexus', 'Pulse', 'Flux',
];
const SYMBOLS = ['!', '@', '#', '$'];

const randomPassword = () => {
  const pick = (arr) => arr[randomBytes(1)[0] % arr.length];
  const num = () => String(randomBytes(1)[0] % 100).padStart(2, '0');
  return [pick(WORDS), pick(WORDS), pick(SYMBOLS), num(), pick(SYMBOLS), pick(WORDS)].join('');
};

const randomEmail = () => {
  const hex = randomBytes(6).toString('hex');
  return `bot_${hex}@zeppost.com`;
};

// ─── Client ───────────────────────────────────────────────────────────────

export class BoxClient {
  /** @param {{ fetchImpl?: Function }} opts */
  constructor({ fetchImpl } = {}) {
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  #fetch;

  /**
   * fetch() with a hard per-request timeout via AbortController. Guarantees no
   * single request can hang indefinitely, which is what lets the overall
   * generation deadline actually be enforced.
   */
  async #fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.#fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Account creation ───────────────────────────────────────────────────

  /**
   * Register a fresh disposable account. No email verification needed —
   * the API returns an accessToken immediately.
   *
   * @returns {Promise<{accessToken:string,refreshToken:string,userId:string,orgId:string,email:string}>}
   */
  async createSession() {
    const email = randomEmail();
    const password = randomPassword();

    const resp = await this.#fetchWithTimeout(`${API_BASE}/api/v1/auth/register`, {
      method: 'POST',
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({
        email,
        password,
        termsAccepted: true,
        locale: 'en',
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error(`[createSession] HTTP ${resp.status}: ${txt.slice(0, 500)}`);
      throw new BoxError('Could not register. Please try again.', {
        status: resp.status,
        body: txt,
      });
    }

    const body = await resp.json();
    const accessToken = body.accessToken;
    const refreshToken = body.refreshToken;

    if (!accessToken) {
      throw new BoxError('Registration succeeded but no access token was returned.');
    }

    return {
      accessToken,
      refreshToken,
      userId: body.user?.id,
      orgId: body.org?.id,
      email,
    };
  }

  // ─── Authenticated request ──────────────────────────────────────────────

  async #api(path, { method = 'GET', body, session, headers = {} } = {}) {
    const url = `${API_BASE}${path}`;
    const reqHeaders = {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${session.accessToken}`,
      ...headers,
    };

    const resp = await this.#fetchWithTimeout(url, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    return resp;
  }

  // ─── Reference upload ───────────────────────────────────────────────────

  /**
   * Upload a reference file (image or video) via multipart form data.
   * Returns the media URL to use in the video creation request.
   *
   * @param {object} session
   * @param {{ data: Buffer, contentType: string, filename: string }} file
   * @returns {Promise<string>} media URL
   */
  async uploadReference(session, file) {
    // file: { path, filename, contentType, bytes } — streamed straight from disk
    // so a large (up to 50 MB) video reference never sits buffered, let alone
    // doubled by a Buffer.concat, in the JS heap.
    const boundary = `----BoxBoundary${randomBytes(8).toString('hex')}`;
    const preamble =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`;
    const closing = `\r\n--${boundary}--\r\n`;
    const preBuf = Buffer.from(preamble, 'utf8');
    const closeBuf = Buffer.from(closing, 'utf8');

    // The exact body length is known up front, so we can set Content-Length and
    // stream the body — no chunked transfer-encoding, byte-identical to the old
    // buffered request the provider already accepted.
    const contentLength = preBuf.length + file.bytes + closeBuf.length;

    async function* multipartBody() {
      yield preBuf;
      for await (const chunk of createReadStream(file.path)) yield chunk;
      yield closeBuf;
    }

    const resp = await this.#fetchWithTimeout(`${API_BASE}/api/v1/studio/uploads`, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(contentLength),
      },
      body: Readable.from(multipartBody()),
      duplex: 'half',
    }, UPLOAD_REQUEST_TIMEOUT_MS);

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error(`[uploadReference] HTTP ${resp.status}: ${txt.slice(0, 500)}`);
      throw new BoxError('Could not upload reference file. Please try again.', {
        status: resp.status,
        body: txt,
      });
    }

    const data = await resp.json();
    if (!data.url) {
      throw new BoxError('Upload succeeded but no media URL was returned.');
    }

    return data.url;
  }

  // ─── Video generation ───────────────────────────────────────────────────

  /**
   * Submit a video generation.
   *
   * @param {object} session
   * @param {{ model: string, prompt: string, seconds: number, size: string, references?: Array<{type:string,url:string}> }} opts
   * @returns {Promise<{ id: string }>}
   */
  async createVideo(session, { model, prompt, seconds, size, references = [] }) {
    const body = {
      model,
      prompt,
      params: {
        seconds,
        size,
        generateAudio: true,
      },
      references,
    };

    const resp = await this.#api('/api/v1/studio/videos', { method: 'POST', session, body });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error(`[createVideo] HTTP ${resp.status}: ${txt.slice(0, 500)}`);

      // HTTP 400 = the provider rejected the request with a specific reason.
      // Extract the human-readable message and surface it to the user.
      if (resp.status === 400) {
        let providerMsg = txt;
        try {
          const parsed = JSON.parse(txt);
          providerMsg = parsed.error || parsed.message || parsed.detail || txt;
        } catch { /* not JSON, use raw text */ }

        // Content/policy blocks -> amber. Other 400s (too small, bad format) -> red.
        const isBlocked = /policy|violation|sensitive|real person|copyright/i.test(String(providerMsg));

        throw new BoxError(String(providerMsg).slice(0, 1000), {
          status: 400,
          body: txt,
          blocked: isBlocked,
        });
      }

      throw new BoxError('Could not start video generation. Please try again.', {
        status: resp.status,
        body: txt,
      });
    }

    const data = await resp.json();
    if (!data.id) {
      throw new BoxError('Video creation response was missing an ID.');
    }

    return { id: data.id };
  }

  // ─── Polling ────────────────────────────────────────────────────────────

  /**
   * Poll a video until it reaches a terminal state.
   *
   * @param {object} session
   * @param {string} videoId
   * @param {{ intervalMs?: number, timeoutMs?: number, onUpdate?: Function }} opts
   * @returns {Promise<{ status: string, videoUrl: string, raw: object }>}
   */
  async waitForVideo(session, videoId, { intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS, onUpdate } = {}) {
    const deadline = Date.now() + timeoutMs;
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    let lastStatus = null;
    let consecutiveFailures = 0;

    while (Date.now() < deadline) {
      // ── Fetch the current status. A dropped socket or a request-timeout is a
      //    transient hiccup, not a dead generation — tolerate a few in a row
      //    rather than throwing the whole job away on one bad poll.
      let resp;
      try {
        resp = await this.#api(`/api/v1/studio/videos/${videoId}`, { session });
      } catch (err) {
        consecutiveFailures += 1;
        console.warn(
          `[waitForVideo] poll request failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new BoxError('Could not check generation status. Please try again.');
        }
        await sleep(intervalMs);
        continue;
      }

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        // 5xx and 429 are transient server-side — keep polling. Everything else
        // (404, 401, other 4xx) is a real fault and fails fast.
        if (resp.status >= 500 || resp.status === 429) {
          consecutiveFailures += 1;
          console.warn(
            `[waitForVideo] transient HTTP ${resp.status} (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${txt.slice(0, 300)}`,
          );
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            throw new BoxError('Could not check generation status. Please try again.', {
              status: resp.status,
              body: txt,
            });
          }
          await sleep(intervalMs);
          continue;
        }
        console.error(`[waitForVideo] HTTP ${resp.status}: ${txt.slice(0, 500)}`);
        throw new BoxError('Could not check generation status. Please try again.', {
          status: resp.status,
          body: txt,
        });
      }

      consecutiveFailures = 0;
      const video = await resp.json();
      const status = video.status;

      if (status !== lastStatus) {
        lastStatus = status;
        if (onUpdate) onUpdate(video);
      }

      if (status === 'COMPLETED') {
        const videoUrl = video.videoUrl;
        if (!videoUrl) {
          throw new BoxError('Generation completed but no video URL was present.', {
            body: video,
          });
        }
        return { status, videoUrl, raw: video };
      }

      if (status === 'FAILED') {
        const errorCode = video.error?.code || '';
        const message = video.error?.message || 'Generation failed with no error message.';
        const blocked = errorCode.includes('PolicyViolation') || errorCode.includes('SensitiveContent');

        throw new BoxError(message, {
          body: video,
          blocked,
        });
      }

      await sleep(intervalMs);
    }

    // Deadline hit — terminal timeout, tagged so it is never retried and gets
    // its own user-facing message.
    throw new BoxError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── Download ───────────────────────────────────────────────────────────

  /**
   * Download a result video from a URL.
   * Returns { data: Buffer, bytes, contentType }.
   */
  async downloadFile(url, { timeoutMs = 180_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const filePath = path.join(os.tmpdir(), `yopisora-${randomBytes(8).toString('hex')}.mp4`);
    try {
      const resp = await this.#fetch(url, { signal: ctrl.signal });
      if (!resp.ok) {
        throw new BoxError('Could not download the result file.', {
          status: resp.status,
        });
      }
      const contentType = resp.headers.get('content-type') || 'video/mp4';

      // Stream the response straight to disk instead of Buffer.from(arrayBuffer()).
      // The old path held the entire video in the JS heap for the whole request,
      // then handed a second copy to the uploader — a big memory spike that is a
      // prime candidate for the OOM SIGKILL. Streaming keeps only small chunks in
      // memory; the file lives on disk and is read back lazily at send time.
      if (resp.body && typeof Readable.fromWeb === 'function') {
        await pipeline(Readable.fromWeb(resp.body), createWriteStream(filePath));
      } else {
        // Fallback for fetch implementations without a web-stream body (e.g. mocks).
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

  // ─── Retry wrapper ──────────────────────────────────────────────────────

  /**
   * Submit a video generation and poll to completion, retrying on transient
   * failures (not on safety/policy blocks).
   */
  async generateWithRetry(session, { model, prompt, seconds, size, references = [], intervalMs, timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS, onUpdate, onRetry, onSubmit } = {}) {
    // ONE deadline for the entire operation. Retries share this budget instead
    // of each getting a fresh full timeout — otherwise a "20 minute timeout"
    // could quietly run for 60 minutes across three attempts before the user
    // heard anything.
    const deadline = Date.now() + timeoutMs;
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    // Don't bother starting a fresh attempt with less than this left on the clock.
    const MIN_RETRY_BUDGET_MS = 15_000;
    let lastErr = null;

    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) {
        if (onRetry) {
          // Cosmetic embed update — never let it take down the generation.
          try { await onRetry(attempt); } catch (err) { console.warn(`onRetry failed: ${err?.message ?? err}`); }
        }
        await sleep(10_000);
      }

      if (deadline - Date.now() <= 0) {
        throw new BoxError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
      }

      // Submit. A submit failure can be transient (network / 5xx), so it is
      // retryable within the remaining budget — but a policy block is terminal.
      let id;
      try {
        ({ id } = await this.createVideo(session, { model, prompt, seconds, size, references }));
      } catch (err) {
        if (err instanceof BoxError && err.blocked) throw err;
        lastErr = err;
        if (attempt < 2 && deadline - Date.now() > MIN_RETRY_BUDGET_MS) continue;
        throw err;
      }

      // Generation now exists on the provider side — persist it immediately so a
      // kill mid-poll can resume it instead of losing it.
      if (onSubmit) {
        try { await onSubmit(id); } catch (err) { console.warn(`onSubmit failed: ${err?.message ?? err}`); }
      }

      // Poll to completion against whatever time is left on the shared deadline.
      try {
        return await this.waitForVideo(session, id, {
          intervalMs,
          timeoutMs: deadline - Date.now(),
          onUpdate,
        });
      } catch (err) {
        // Safety blocks and timeouts are terminal — never retry them.
        if (err instanceof BoxError && (err.blocked || err.timedOut)) throw err;
        lastErr = err;
        if (attempt < 2 && deadline - Date.now() > MIN_RETRY_BUDGET_MS) continue;
        throw err;
      }
    }

    throw lastErr ?? new BoxError('Generation failed after multiple retries.');
  }
}

// ─── Failure classification ───────────────────────────────────────────────

/**
 * Classify an error for Discord embed coloring.
 *
 * blocked = true  → amber (policy violation / safety check)
 * blocked = false → red (genuine fault)
 */
export function classifyBoxFailure(err) {
  if (err instanceof BoxError && err.blocked) {
    return {
      blocked: true,
      message: err.message,
    };
  }

  if (err instanceof BoxError) {
    return {
      blocked: false,
      message: err.message,
    };
  }

  return {
    blocked: false,
    message: err?.message || 'An unexpected error occurred.',
  };
}
