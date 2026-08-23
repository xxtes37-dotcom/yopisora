import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  ActivityType,
  AttachmentBuilder,
  Options,
} from 'discord.js';
import {
  BoxClient,
  BoxError,
  classifyBoxFailure,
  SD25_MODEL,
  SD25_DURATIONS,
  SD25_DEFAULT_DURATION,
  SD25_RATIOS,
  SD25_DEFAULT_RATIO,
  SD25_RESOLUTIONS,
  SD25_DEFAULT_RESOLUTION,
  SD25_SIZES,
  SD25_MAX_IMAGES,
  SD25_MAX_VIDEOS,
  SD2FAST_MODEL,
  SD2FAST_DURATIONS,
  SD2FAST_DEFAULT_DURATION,
  SD2FAST_RATIOS,
  SD2FAST_DEFAULT_RATIO,
  SD2FAST_SIZES,
  SD2FAST_MAX_IMAGES,
  SD2FAST_MAX_VIDEOS,
  SD2_MODEL,
  SD2_DURATIONS,
  SD2_DEFAULT_DURATION,
  SD2_RATIOS,
  SD2_DEFAULT_RATIO,
  SD2_SIZES,
  SD2_MAX_IMAGES,
  SD2_MAX_VIDEOS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_VIDEO_TIMEOUT_MS,
} from './boxverse.js';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createSlotManager } from './slots.js';
import { createJobStore } from './jobstore.js';

const {
  DISCORD_TOKEN,
  DISCORD_GUILD_ID,
  GEN_POLL_INTERVAL_MS = '5000',
  GEN_VIDEO_TIMEOUT_MS = '600000',
  GEN_MAX_CONCURRENT_PER_USER = '3',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing. Fill it in .env');
  process.exit(1);
}
if (!DISCORD_GUILD_ID) {
  console.error('DISCORD_GUILD_ID is missing. The bot is restricted to a single server.');
  process.exit(1);
}

const box = new BoxClient();
const jobStore = createJobStore({ dir: process.env.GEN_JOB_STORE_DIR || './.jobs' });

// Remove a temp download file without ever throwing.
const safeUnlink = (p) => (p ? unlink(p).catch(() => {}) : Promise.resolve());

const POLL_MS = Number(GEN_POLL_INTERVAL_MS);
const VIDEO_TIMEOUT = Number(GEN_VIDEO_TIMEOUT_MS);
const MAX_PER_USER = Number(GEN_MAX_CONCURRENT_PER_USER);

const UPLOAD_LIMIT_BY_TIER = { 0: 10, 1: 10, 2: 50, 3: 100 };
const uploadLimitBytes = (guild) => {
  const explicit = guild?.maximumUploadLimit;
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const tier = Number(guild?.premiumTier ?? 0);
  return (UPLOAD_LIMIT_BY_TIER[tier] ?? 10) * 1024 * 1024;
};

const slots = createSlotManager({
  maxPerUser: MAX_PER_USER,
  maxJobAgeMs: VIDEO_TIMEOUT + 60_000,
});

const takeSlot = (userId) => slots.take(userId);
const releaseSlot = (userId, jobId) => slots.release(userId, jobId);
const runningCount = (userId) => slots.running(userId);

const COLOR_WORKING = 0x5865f2;
const COLOR_DONE = 0x57f287;
const COLOR_BLOCKED = 0xfee75c;
const COLOR_ERROR = 0xed4245;

const fmtElapsed = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const truncate = (s, n = 1000) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const isImageAttachment = (a) =>
  Boolean(a) && (a.contentType?.startsWith('image/') || IMAGE_EXT.test(a.name ?? ''));

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const isVideoAttachment = (a) =>
  Boolean(a) && (a.contentType?.startsWith('video/') || VIDEO_EXT.test(a.name ?? ''));

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * MB;
const MAX_VIDEO_BYTES = 50 * MB;
const MIN_IMAGE_DIMENSION = 300;
const fmtMB = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

const fetchAttachmentToFile = async (attachment) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const filePath = path.join(os.tmpdir(), `yopisora-ref-${randomBytes(8).toString('hex')}`);
  try {
    const resp = await fetch(attachment.url, { signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(`Could not download ${attachment.name}.`);
    }
    // Stream Discord's copy straight to disk — never hold the reference file in
    // the heap. It's read back lazily during the multipart upload.
    if (resp.body && typeof Readable.fromWeb === 'function') {
      await pipeline(Readable.fromWeb(resp.body), createWriteStream(filePath));
    } else {
      await writeFile(filePath, Buffer.from(await resp.arrayBuffer()));
    }
    const { size } = await stat(filePath);
    return {
      path: filePath,
      filename: attachment.name || 'file',
      contentType: attachment.contentType || 'application/octet-stream',
      bytes: size,
    };
  } catch (err) {
    await safeUnlink(filePath);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

// On a 1 GB host, unbounded discord.js caches are a slow-motion OOM — messages
// the bot posts and users it fetches accumulate for the whole uptime. Keep only
// what's actually used and sweep the rest. Essential managers (guilds, channels,
// roles) keep their defaults via the spread.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 15,
    UserManager: { maxSize: 40, keepOverLimit: (user) => user.id === client.user?.id },
    GuildMemberManager: { maxSize: 40, keepOverLimit: (member) => member.id === client.user?.id },
    PresenceManager: 0,
    ThreadManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 600 },
    users: { interval: 3600, filter: () => (user) => user.id !== client.user?.id },
  },
});

client.once('clientReady', async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Server: ${DISCORD_GUILD_ID} (locked)`);
  console.log(`Limit:  ${MAX_PER_USER} concurrent per user (cleared on restart)`);
  c.user.setActivity('/sd2-5 • /sd2fast • /sd2', { type: ActivityType.Listening });
  // Recover any generations that were mid-flight when the bot last went down.
  resumePendingJobs().catch((err) => console.error('Resume sweep failed:', err));
});

// ─── Shared helpers ───────────────────────────────────────────────────────

function makeAnchorFns({ interaction = null, channel = null } = {}) {
  let anchor = null;

  const resolveChannel = async () => {
    if (channel) return channel;
    if (interaction) return interaction.channel ?? (await client.channels.fetch(interaction.channelId).catch(() => null));
    return null;
  };

  const finalise = async (embed) => {
    if (anchor) {
      try { await anchor.edit({ embeds: [embed] }); return; }
      catch (err) { console.warn(`anchor.edit failed: ${err.message}`); }
      return;
    }
    if (interaction) {
      try { await interaction.editReply({ embeds: [embed] }); }
      catch (err) { console.warn(`editReply failed: ${err.message}`); }
    }
  };

  const setAnchor = (msg) => { anchor = msg; };

  const replyToAnchor = async (body) => {
    try { if (anchor) { await anchor.reply(body); return; } }
    catch (err) { console.warn(`Could not reply to anchor: ${err.message}`); }
    try {
      const ch = await resolveChannel();
      await ch?.send(body);
    } catch (err) { console.error(`Could not deliver result: ${err.message}`); }
  };

  return { finalise, replyToAnchor, setAnchor };
}

function collectReferences(interaction, imageNames, maxImages, videoNames, maxVideos) {
  const imageAtts = imageNames.map((n) => interaction.options.getAttachment(n)).filter(Boolean);
  const videoAtts = videoNames.map((n) => interaction.options.getAttachment(n)).filter(Boolean);

  const badImage = imageAtts.find((a) => !isImageAttachment(a));
  if (badImage) {
    return { error: `\`${badImage.name}\` doesn't look like an image. Upload a PNG, JPG or WEBP.` };
  }
  const badVideo = videoAtts.find((a) => !isVideoAttachment(a));
  if (badVideo) {
    return { error: `\`${badVideo.name}\` doesn't look like a video. Upload an MP4 or MOV.` };
  }

  const oversizedImage = imageAtts.find((a) => a.size > MAX_IMAGE_BYTES);
  if (oversizedImage) {
    return { error: `\`${oversizedImage.name}\` is ${fmtMB(oversizedImage.size)} — images must be under ${fmtMB(MAX_IMAGE_BYTES)}.` };
  }

  // The API rejects reference images smaller than 300px in any dimension.
  const tooSmall = imageAtts.find((a) => (a.width ?? 0) < MIN_IMAGE_DIMENSION || (a.height ?? 0) < MIN_IMAGE_DIMENSION);
  if (tooSmall) {
    return { error: `\`${tooSmall.name}\` is ${tooSmall.width ?? '?'}x${tooSmall.height ?? '?'}px — reference images must be at least ${MIN_IMAGE_DIMENSION}px in both dimensions.` };
  }
  const oversizedVideo = videoAtts.find((a) => a.size > MAX_VIDEO_BYTES);
  if (oversizedVideo) {
    return { error: `\`${oversizedVideo.name}\` is ${fmtMB(oversizedVideo.size)} — videos must be under ${fmtMB(MAX_VIDEO_BYTES)}.` };
  }

  return {
    images: imageAtts.slice(0, maxImages),
    videos: videoAtts.slice(0, maxVideos),
    error: null,
  };
}

async function handleGenerationError(err, { finalise, replyToAnchor, interaction, prompt, user, commandName, taskIdRef }) {
  // ── Timeout gets its own clean message: edit the working card to a timed-out
  //    state, then reply to the original message and ping the user.
  if (err instanceof BoxError && err.timedOut) {
    const minutes = Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000));

    const timedOutCard = new EmbedBuilder()
      .setColor(COLOR_BLOCKED)
      .setAuthor({ name: commandName })
      .setTitle('Your video timed out')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({
        name: 'What happened',
        value: `The generation ran for the full ${minutes} minutes without finishing. Try generating it again.`,
      });
    if (taskIdRef.value) timedOutCard.addFields({ name: 'Generation ID', value: `\`\`\`${taskIdRef.value}\`\`\`` });
    timedOutCard
      .setFooter({ text: `Requested by ${user.username} • timed out`, iconURL: user.displayAvatarURL() })
      .setTimestamp();

    await finalise(
      new EmbedBuilder()
        .setColor(COLOR_BLOCKED)
        .setAuthor({ name: commandName })
        .setTitle('Your video timed out')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp(),
    );
    await replyToAnchor({
      content: `${user} Your video has timed out — it has taken ${minutes} minutes. Try regenerating again.`,
      embeds: [timedOutCard],
    });

    console.log(`${taskIdRef.value ?? 'no-task'} timed out after ${minutes} minutes`);
    return;
  }

  const { blocked, message } = classifyBoxFailure(err);
  if (!blocked && !(err instanceof BoxError)) console.error(err);

  const failed = new EmbedBuilder()
    .setColor(blocked ? COLOR_BLOCKED : COLOR_ERROR)
    .setAuthor({ name: commandName })
    .setTitle(blocked ? 'Prompt blocked' : 'Generation failed')
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({ name: blocked ? 'Reason' : 'What happened', value: truncate(message, 1000) });

  if (taskIdRef.value) failed.addFields({ name: 'Generation ID', value: `\`\`\`${taskIdRef.value}\`\`\`` });

  failed
    .setFooter({
      text: blocked ? `Requested by ${user.username} • try rephrasing` : `Requested by ${user.username}`,
      iconURL: user.displayAvatarURL(),
    })
    .setTimestamp();

  await finalise(
    new EmbedBuilder()
      .setColor(blocked ? COLOR_BLOCKED : COLOR_ERROR)
      .setAuthor({ name: commandName })
      .setTitle(blocked ? 'Prompt blocked' : 'Generation failed')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
      .setTimestamp(),
  );
  await replyToAnchor({ content: `${user}`, embeds: [failed] });

  console.log(`${taskIdRef.value ?? 'no-task'} ${blocked ? 'blocked' : 'failed'}: ${message}`);
}

/**
 * Shared generation handler. Both /sd2-5 and /sd2fast use this — they only
 * differ in model name, durations, sizes, and reference limits.
 */
async function runGeneration(interaction, {
  commandName,
  model,
  durations,
  defaultDuration,
  ratios,
  defaultRatio,
  resolutions,
  defaultResolution,
  sizes,
  maxImages,
  maxVideos,
  imageOptionNames,
  videoOptionNames,
}) {
  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);

  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running — wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const taskIdRef = { value: null };
  const { finalise, replyToAnchor, setAnchor } = makeAnchorFns({ interaction });

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? defaultDuration;
    const ratio = interaction.options.getString('aspect') ?? defaultRatio;
    const resolution = interaction.options.getString('resolution') ?? defaultResolution;
    const sizeMap = sizes[resolution] ?? sizes[defaultResolution];
    const size = sizeMap[ratio] ?? sizeMap[defaultRatio];

    const { images: imgAtts, videos: vidAtts, error: refError } = collectReferences(
      interaction, imageOptionNames, maxImages, videoOptionNames, maxVideos,
    );

    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }

    const startedAt = Date.now();

    await interaction.deferReply();

    // "Preparing" embed
    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: [`\`${duration}s\``, `\`${ratio}\``, `\`${resolution}\``].join(' • ') })
      .setFooter({ text: `Requested by ${user.username} • creating a session…`, iconURL: user.displayAvatarURL() })
      .setTimestamp();

    const refCount = imgAtts.length + vidAtts.length;
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      preparing.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) preparing.setThumbnail(imgAtts[0].url);
    }

    const anchor = await interaction.editReply({ embeds: [preparing] });
    setAnchor(anchor);

    // Create a fresh session
    const session = await box.createSession();

    // Upload references if any
    let references = [];
    if (refCount > 0) {
      const uploading = new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: commandName })
        .setTitle('Uploading references')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Settings', value: [`\`${duration}s\``, `\`${ratio}\``, `\`480p\``].join(' • ') })
        .setFooter({ text: `Requested by ${user.username} • uploading ${refCount} file${refCount > 1 ? 's' : ''}…`, iconURL: user.displayAvatarURL() })
        .setTimestamp();

      if (imgAtts.length) {
        uploading.addFields({ name: 'References', value: `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` });
        uploading.setThumbnail(imgAtts[0].url);
      }

      await finalise(uploading);

      for (const att of imgAtts) {
        const file = await fetchAttachmentToFile(att);
        try {
          const url = await box.uploadReference(session, file);
          references.push({ type: 'image', url });
        } finally {
          await safeUnlink(file.path);
        }
      }
      for (const att of vidAtts) {
        const file = await fetchAttachmentToFile(att);
        try {
          const url = await box.uploadReference(session, file);
          references.push({ type: 'video', url });
        } finally {
          await safeUnlink(file.path);
        }
      }
    }

    // "Generating" embed
    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: [`\`${duration}s\``, `\`${ratio}\``, `\`${resolution}\``, `\`audio on\``].join(' • ') })
      .setFooter({ text: `Requested by ${user.username} • this takes a couple of minutes`, iconURL: user.displayAvatarURL() })
      .setTimestamp();

    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      working.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) working.setThumbnail(imgAtts[0].url);
    }

    await finalise(working);

    // Submit + poll with retry
    const { videoUrl, raw } = await box.generateWithRetry(session, {
      model,
      prompt,
      seconds: duration,
      size,
      references,
      intervalMs: POLL_MS,
      timeoutMs: VIDEO_TIMEOUT,
      onUpdate: (video) => { taskIdRef.value = video.id; },
      onSubmit: async (videoId) => {
        // The generation now exists provider-side. Persist everything needed to
        // resume it after a restart: where to deliver, how to authenticate the
        // poll, and when the budget runs out.
        taskIdRef.value = videoId;
        try {
          await jobStore.save({
            jobId,
            userId: user.id,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            anchorMessageId: anchor.id,
            commandName,
            model,
            prompt,
            videoId,
            session,
            duration,
            ratio,
            resolution,
            refCount,
            deadlineAt: startedAt + VIDEO_TIMEOUT,
            createdAt: startedAt,
          });
        } catch (err) {
          console.warn(`Could not persist job ${jobId}: ${err?.message ?? err}`);
        }
      },
      onRetry: async (attempt) => {
        await finalise(new EmbedBuilder()
          .setColor(COLOR_BLOCKED)
          .setAuthor({ name: commandName })
          .setTitle('Retrying…')
          .setDescription(`>>> ${truncate(prompt, 900)}`)
          .addFields({ name: 'Status', value: `Retry attempt ${attempt} of 2…` })
          .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
          .setTimestamp());
      },
    });

    taskIdRef.value = raw?.id ?? taskIdRef.value;

    // Download the video (streamed to a temp file, never held whole in memory).
    const file = await box.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / (1024 * 1024)).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          {
            name: 'Settings',
            value: [`\`${duration}s\``, `\`${ratio}\``, `\`${resolution}\``, `\`audio on\``, `\`${fmtElapsed(Date.now() - startedAt)}\``].join(' • '),
          },
          { name: 'Generation ID', value: `\`\`\`${taskIdRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp();

      if (refCount) {
        const refSummary = [
          imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
          vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
        ].filter(Boolean).join(', ');
        done.addFields({ name: 'References', value: refSummary });
      }

      await finalise(done);

      if (file.bytes >= limit) {
        await replyToAnchor({
          content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / (1024 * 1024))} MB upload limit.`,
        });
        console.log(`${taskIdRef.value} succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({
          content: `${user}`,
          files: [new AttachmentBuilder(createReadStream(file.path), { name: 'sd2-video.mp4' })],
        });
        console.log(`${taskIdRef.value} succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor, interaction,
        prompt: interaction.options.getString('prompt', true),
        user, commandName, taskIdRef,
      });
    } catch (fatal) {
      console.error(`Unhandled error in ${commandName} for ${user.tag}:`, fatal);
      try {
        const body = { content: 'Something went wrong starting that generation.' };
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
      } catch { /* interaction unusable */ }
    }
  } finally {
    releaseSlot(user.id, jobId);
    // Reached a terminal state (delivered or reported) — the job no longer needs
    // to survive a restart.
    await jobStore.remove(jobId);
  }
}

// ─── Resume after a restart ──────────────────────────────────────────────────
// SIGKILL (OOM, deploy, host reap) can't be caught in-process, so surviving it
// means persistence, not signal handlers. Every generation is written to the job
// store the instant it's submitted; on boot we re-poll each pending job against
// its stored session and deliver the result to the original message. A render
// that was in flight when the bot died is picked back up, not lost.

// A stand-in user shape so delivery/embeds work even if the real user can't be
// fetched on resume (left the server, etc.).
function resumeUser(user, id) {
  if (user) return user;
  return { username: 'user', displayAvatarURL: () => undefined, toString: () => `<@${id}>` };
}

async function resumePendingJobs() {
  let records;
  try { records = await jobStore.list(); }
  catch (err) { console.error('Could not read job store:', err); return; }
  if (!records.length) return;
  console.log(`Resuming ${records.length} pending generation(s) from a previous run…`);
  for (const rec of records) {
    resumeOne(rec).catch((err) => console.error(`Resume of ${rec.jobId} failed:`, err));
  }
}

async function resumeOne(rec) {
  // Re-locate the original message so we can edit it and reply beneath it.
  let channel = null;
  let anchor = null;
  try {
    channel = await client.channels.fetch(rec.channelId);
    anchor = await channel.messages.fetch(rec.anchorMessageId);
  } catch (err) {
    console.warn(`Resume ${rec.jobId}: original message is gone (${err.message}); dropping.`);
    await jobStore.remove(rec.jobId);
    return;
  }

  const user = await client.users.fetch(rec.userId).catch(() => null);
  const commandName = rec.commandName ?? 'Generation';
  const prompt = rec.prompt ?? '';
  const taskIdRef = { value: rec.videoId };

  const { finalise, replyToAnchor, setAnchor } = makeAnchorFns({ channel });
  setAnchor(anchor);

  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();

    if (remaining <= 0) {
      // The 20-minute budget expired while the bot was down — report it cleanly
      // so the render never just sits frozen on "Generating".
      await handleGenerationError(
        new BoxError(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, interaction: null, prompt, user: resumeUser(user, rec.userId), commandName, taskIdRef },
      );
      return;
    }

    // Let the user know it was picked back up.
    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: commandName })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart — still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const { videoUrl, raw } = await box.waitForVideo(rec.session, rec.videoId, {
      intervalMs: POLL_MS,
      timeoutMs: remaining,
      onUpdate: (video) => { taskIdRef.value = video.id; },
    });
    taskIdRef.value = raw?.id ?? taskIdRef.value;

    const file = await box.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / (1024 * 1024)).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          {
            name: 'Settings',
            value: [`\`${rec.duration}s\``, `\`${rec.ratio}\``, `\`${rec.resolution}\``, '`audio on`', '`recovered`'].filter(Boolean).join(' • '),
          },
          { name: 'Generation ID', value: `\`\`\`${taskIdRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();

      await finalise(done);

      if (file.bytes >= limit) {
        await replyToAnchor({
          content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / (1024 * 1024))} MB upload limit.`,
        });
        console.log(`${taskIdRef.value} (resumed) succeeded (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({
          content: `${mention}`,
          files: [new AttachmentBuilder(createReadStream(file.path), { name: 'sd2-video.mp4' })],
        });
        console.log(`${taskIdRef.value} (resumed) succeeded (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor, interaction: null,
        prompt, user: resumeUser(user, rec.userId), commandName, taskIdRef,
      });
    } catch (fatal) {
      console.error(`Resume ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

// ─── /sd2-5 handler ───────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'sd2-5') return;

  await runGeneration(interaction, {
    commandName: 'Seedance 2.5',
    model: SD25_MODEL,
    durations: SD25_DURATIONS,
    defaultDuration: SD25_DEFAULT_DURATION,
    ratios: SD25_RATIOS,
    defaultRatio: SD25_DEFAULT_RATIO,
    resolutions: SD25_RESOLUTIONS,
    defaultResolution: SD25_DEFAULT_RESOLUTION,
    sizes: SD25_SIZES,
    maxImages: SD25_MAX_IMAGES,
    maxVideos: SD25_MAX_VIDEOS,
    imageOptionNames: ['img1', 'img2', 'img3', 'img4'],
    videoOptionNames: ['vid1'],
  });
});

// ─── /sd2fast handler ─────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'sd2fast') return;

  await runGeneration(interaction, {
    commandName: 'Seedance 2.0 Fast',
    model: SD2FAST_MODEL,
    durations: SD2FAST_DURATIONS,
    defaultDuration: SD2FAST_DEFAULT_DURATION,
    ratios: SD2FAST_RATIOS,
    defaultRatio: SD2FAST_DEFAULT_RATIO,
    resolutions: ['720p'],
    defaultResolution: '720p',
    sizes: { '720p': SD2FAST_SIZES },
    maxImages: SD2FAST_MAX_IMAGES,
    maxVideos: SD2FAST_MAX_VIDEOS,
    imageOptionNames: ['img1', 'img2', 'img3'],
    videoOptionNames: ['vid1'],
  });
});

// ─── /sd2 handler ─────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'sd2') return;

  await runGeneration(interaction, {
    commandName: 'Seedance 2.0',
    model: SD2_MODEL,
    durations: SD2_DURATIONS,
    defaultDuration: SD2_DEFAULT_DURATION,
    ratios: SD2_RATIOS,
    defaultRatio: SD2_DEFAULT_RATIO,
    resolutions: ['480p'],
    defaultResolution: '480p',
    sizes: { '480p': SD2_SIZES },
    maxImages: SD2_MAX_IMAGES,
    maxVideos: SD2_MAX_VIDEOS,
    imageOptionNames: ['img1', 'img2', 'img3'],
    videoOptionNames: ['vid1'],
  });
});

// ─── Resilience ────────────────────────────────────────────────────────────
// Gateway/websocket lifecycle. discord.js reconnects on its own; these listeners
// just make the process observable instead of silently dropping offline.
client.on('error', (err) => console.error('Client error:', err));
client.on('shardError', (err) => console.error('Shard websocket error:', err));
client.on('shardDisconnect', (event, id) =>
  console.warn(`Shard ${id} disconnected (code ${event?.code ?? '?'}) — reconnecting…`));
client.on('shardReconnecting', (id) => console.warn(`Shard ${id} reconnecting…`));
client.on('shardResume', (id) => console.log(`Shard ${id} resumed.`));

// The real fix for the "bot randomly gets killed and restarts" bug.
// Every command already runs inside its own try/catch, so a rejection or throw
// that reaches this far is almost always a background hiccup — a dropped socket,
// a late Discord API error, an aborted fetch. Previously an uncaught exception
// crashed Node and the process supervisor restarted the whole bot (killing any
// in-flight generation, which is exactly why some videos never reported their
// timeout). Log it and stay up instead.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (ignored, staying up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored, staying up):', err);
});

// Clean shutdown so a real SIGTERM/SIGINT (deploy, Ctrl-C) closes the gateway
// gracefully instead of being mistaken for a crash.
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — shutting down cleanly…`);
  try {
    await client.destroy();
  } catch (err) {
    console.error('Error during shutdown:', err);
  }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Failed to log in to Discord:', err);
  process.exit(1);
});
