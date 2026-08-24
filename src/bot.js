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
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import {
  WanClient,
  WanError,
  classifyWanFailure,
  WAN_DURATIONS,
  WAN_DEFAULT_DURATION,
  WAN_RATIOS,
  WAN_DEFAULT_RATIO,
  WAN_RESOLUTIONS,
  WAN_DEFAULT_RESOLUTION,
  WAN_MAX_IMAGES,
  WAN_MAX_VIDEOS,
} from './wan.js';
import {
  FluxClient,
  FluxError,
  FLUX_DURATIONS,
  FLUX_DEFAULT_DURATION,
  FLUX_RATIOS,
  FLUX_DEFAULT_RATIO,
} from './flux.js';
import {
  Sd2Client,
  Sd2Error,
  SD2_DEFAULT_DURATION,
  SD2_DEFAULT_RESOLUTION,
  SD2_DEFAULT_RATIO,
  SD2_MAX_IMAGES,
  SD2_MAX_VIDEOS,
} from './sd2.js';
import { createSlotManager } from './slots.js';
import { createJobStore } from './jobstore.js';

const {
  DISCORD_TOKEN,
  DISCORD_GUILD_ID,
  DASHSCOPE_API_KEY,
  GEN_POLL_INTERVAL_MS = '15000',
  GEN_VIDEO_TIMEOUT_MS = '1200000',
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
if (!DASHSCOPE_API_KEY) {
  console.error('DASHSCOPE_API_KEY is missing. Fill it in .env');
  process.exit(1);
}

const wan = new WanClient();
const flux = new FluxClient();
const sd2 = new Sd2Client();
const jobStore = createJobStore({ dir: process.env.GEN_JOB_STORE_DIR || './.jobs' });

const safeUnlink = (p) => (p ? unlink(p).catch(() => {}) : Promise.resolve());

const POLL_MS = Number(GEN_POLL_INTERVAL_MS);
const VIDEO_TIMEOUT = Number(GEN_VIDEO_TIMEOUT_MS);
const MAX_PER_USER = Number(GEN_MAX_CONCURRENT_PER_USER);

const UPLOAD_LIMIT_BY_TIER = { 0: 10, 1: 25, 2: 50, 3: 100 };
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
  return str.length > n ? `${str.slice(0, n - 1)}\u2026` : str;
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const isImageAttachment = (a) =>
  Boolean(a) && (a.contentType?.startsWith('image/') || IMAGE_EXT.test(a.name ?? ''));

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const isVideoAttachment = (a) =>
  Boolean(a) && (a.contentType?.startsWith('video/') || VIDEO_EXT.test(a.name ?? ''));

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * MB;
const MAX_VIDEO_BYTES = 100 * MB;
const fmtMB = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  // Bounded caches so a long-running bot on a small host doesn't slowly OOM.
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
  c.user.setActivity('/wan-3 • /flux-3 • /sd2', { type: ActivityType.Listening });
  resumePendingJobs().catch((err) => console.error('Resume sweep failed:', err));
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

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

// Collect reference attachments and return their public URLs. WAN3 fetches these
// directly (input.media), so there is no upload step.
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
    return { error: `\`${oversizedImage.name}\` is ${fmtMB(oversizedImage.size)} \u2014 images must be under ${fmtMB(MAX_IMAGE_BYTES)}.` };
  }
  const oversizedVideo = videoAtts.find((a) => a.size > MAX_VIDEO_BYTES);
  if (oversizedVideo) {
    return { error: `\`${oversizedVideo.name}\` is ${fmtMB(oversizedVideo.size)} \u2014 videos must be under ${fmtMB(MAX_VIDEO_BYTES)}.` };
  }

  const images = imageAtts.slice(0, maxImages);
  const videos = videoAtts.slice(0, maxVideos);
  const references = [
    ...images.map((a) => ({ type: 'image', url: a.url })),
    ...videos.map((a) => ({ type: 'video', url: a.url })),
  ];
  return { images, videos, references, error: null };
}

async function handleGenerationError(err, { finalise, replyToAnchor, prompt, user, idRef, commandName = 'Generation', idLabel = 'ID' }) {
  const idVal = idRef?.value;

  // Timeout gets its own clean message (works for WanError and FluxError).
  if (err?.timedOut) {
    const minutes = Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000));
    const card = new EmbedBuilder()
      .setColor(COLOR_BLOCKED)
      .setAuthor({ name: commandName })
      .setTitle('Your video timed out')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'What happened', value: `The generation ran for the full ${minutes} minutes without finishing. Try generating it again.` });
    if (idVal) card.addFields({ name: idLabel, value: `\`\`\`${idVal}\`\`\`` });
    card.setFooter({ text: `Requested by ${user.username} \u2022 timed out`, iconURL: user.displayAvatarURL?.() }).setTimestamp();

    await finalise(
      new EmbedBuilder()
        .setColor(COLOR_BLOCKED)
        .setAuthor({ name: commandName })
        .setTitle('Your video timed out')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
        .setTimestamp(),
    );
    await replyToAnchor({ content: `${user} Your video has timed out \u2014 it has taken ${minutes} minutes. Try regenerating again.`, embeds: [card] });
    console.log(`${idVal ?? 'no-task'} timed out after ${minutes} minutes`);
    return;
  }

  const blocked = Boolean(err?.blocked);
  const message = err?.message || 'An unexpected error occurred.';
  if (!blocked) console.error(err);

  const failed = new EmbedBuilder()
    .setColor(blocked ? COLOR_BLOCKED : COLOR_ERROR)
    .setAuthor({ name: commandName })
    .setTitle(blocked ? 'Prompt blocked' : 'Generation failed')
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({ name: blocked ? 'Reason' : 'What happened', value: truncate(message, 1000) });
  if (idVal) failed.addFields({ name: idLabel, value: `\`\`\`${idVal}\`\`\`` });
  failed
    .setFooter({ text: blocked ? `Requested by ${user.username} \u2022 try rephrasing` : `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
    .setTimestamp();

  await finalise(
    new EmbedBuilder()
      .setColor(blocked ? COLOR_BLOCKED : COLOR_ERROR)
      .setAuthor({ name: commandName })
      .setTitle(blocked ? 'Prompt blocked' : 'Generation failed')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
      .setTimestamp(),
  );
  await replyToAnchor({ content: `${user}`, embeds: [failed] });
  console.log(`${idVal ?? 'no-task'} ${blocked ? 'blocked' : 'failed'}: ${message}`);
}

const settingsLine = (duration, ratio, resolution, extra = []) =>
  [`\`${duration}s\``, `\`${ratio}\``, `\`${resolution}\``, '`audio on`', ...extra].join(' \u2022 ');

// ─── /wan-3 generation handler ───────────────────────────────────────────────

async function runGeneration(interaction) {
  const commandName = 'WAN 3.0';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const taskIdRef = { value: null };
  const startedAt = Date.now();
  const { finalise, replyToAnchor, setAnchor } = makeAnchorFns({ interaction });

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? WAN_DEFAULT_DURATION;
    const ratio = interaction.options.getString('ratio') ?? WAN_DEFAULT_RATIO;
    const resolution = interaction.options.getString('resolution') ?? WAN_DEFAULT_RESOLUTION;

    const { images: imgAtts, videos: vidAtts, references, error: refError } = collectReferences(
      interaction, ['img1', 'img2', 'img3', 'img4'], WAN_MAX_IMAGES, ['vid1'], WAN_MAX_VIDEOS,
    );
    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }
    const refCount = (imgAtts?.length ?? 0) + (vidAtts?.length ?? 0);

    await interaction.deferReply();

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: settingsLine(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
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

    // Submit the task.
    const { taskId } = await wan.createTask({ prompt, duration, ratio, resolution, references });
    taskIdRef.value = taskId;

    // Persist immediately so a crash/kill mid-render can resume it.
    try {
      await jobStore.save({
        jobId,
        userId: user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        anchorMessageId: anchor.id,
        prompt,
        duration,
        ratio,
        resolution,
        refCount,
        taskId,
        deadlineAt: startedAt + VIDEO_TIMEOUT,
        createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist job ${jobId}: ${err?.message ?? err}`);
    }

    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: settingsLine(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
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

    // Poll to completion against the 20-minute budget.
    const { videoUrl } = await wan.waitForTask(taskId, {
      intervalMs: POLL_MS,
      timeoutMs: VIDEO_TIMEOUT,
      onUpdate: (out) => { if (out?.task_id) taskIdRef.value = out.task_id; },
    });

    // Download (streamed to a temp file, never held whole in memory).
    const file = await wan.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: settingsLine(duration, ratio, resolution, [`\`${fmtElapsed(Date.now() - startedAt)}\``]) },
          { name: 'Task ID', value: `\`\`\`${taskIdRef.value ?? ''}\`\`\`` },
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
          content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.`,
        });
        console.log(`${taskIdRef.value} succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({
          content: `${user}`,
          files: [new AttachmentBuilder(createReadStream(file.path), { name: 'wan3-video.mp4' })],
        });
        console.log(`${taskIdRef.value} succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef: taskIdRef, commandName: 'WAN 3.0', idLabel: 'Task ID',
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
    await jobStore.remove(jobId);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'wan-3') return runGeneration(interaction);
  if (interaction.commandName === 'flux-3') return runFluxGeneration(interaction);
  if (interaction.commandName === 'sd2') return runSd2Generation(interaction);
});

// ─── /sd2 generation handler (Seedance 2.0 via Volcengine ARK) ───────────────

async function runSd2Generation(interaction) {
  const commandName = 'Seedance 2.0';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const idRef = { value: null };
  const startedAt = Date.now();
  const { finalise, replyToAnchor, setAnchor } = makeAnchorFns({ interaction });
  const sd2Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? SD2_DEFAULT_DURATION;
    const resolution = interaction.options.getString('resolution') ?? SD2_DEFAULT_RESOLUTION;
    const ratio = interaction.options.getString('ratio') ?? SD2_DEFAULT_RATIO;

    const { images: imgAtts, videos: vidAtts, references, error: refError } = collectReferences(
      interaction, ['img1', 'img2', 'img3'], SD2_MAX_IMAGES, ['vid1'], SD2_MAX_VIDEOS,
    );
    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }
    const refCount = (imgAtts?.length ?? 0) + (vidAtts?.length ?? 0);

    await interaction.deferReply();

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
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

    const { taskId } = await sd2.createTask({ prompt, duration, resolution, ratio, references });
    idRef.value = taskId;

    try {
      await jobStore.save({
        jobId, kind: 'sd2', userId: user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, anchorMessageId: anchor.id,
        prompt, duration, ratio, resolution, refCount, taskId,
        deadlineAt: startedAt + VIDEO_TIMEOUT, createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist sd2 job ${jobId}: ${err?.message ?? err}`);
    }

    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
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

    const { videoUrl } = await sd2.waitForTask(taskId, { intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {} });

    const file = await sd2.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd2Settings(duration, ratio, resolution, [`\`${fmtElapsed(Date.now() - startedAt)}\``]) },
          { name: 'Task ID', value: `\`\`\`${idRef.value ?? ''}\`\`\`` },
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
        await replyToAnchor({ content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        console.log(`${idRef.value} (sd2) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance2-video.mp4' })] });
        console.log(`${idRef.value} (sd2) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef, commandName, idLabel: 'Task ID',
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
    await jobStore.remove(jobId);
  }
}

// ─── /flux-3 generation handler ──────────────────────────────────────────────
// Each run spins up a disposable Synthesia account (temp.tf email -> Cognito
// signup -> email code -> freemium credits), generates FLUX 3, then downloads it.

async function runFluxGeneration(interaction) {
  const commandName = 'FLUX 3';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const idRef = { value: null };
  const startedAt = Date.now();
  const { finalise, replyToAnchor, setAnchor } = makeAnchorFns({ interaction });

  const fluxSettings = (d, r) => [`\`${d}s\``, `\`${r}\``, '`audio on`'].join(' \u2022 ');

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? FLUX_DEFAULT_DURATION;
    const ratio = interaction.options.getString('ratio') ?? FLUX_DEFAULT_RATIO;

    await interaction.deferReply();

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: fluxSettings(duration, ratio) })
      .setFooter({ text: `Requested by ${user.username} \u2022 creating a session\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    const anchor = await interaction.editReply({ embeds: [preparing] });
    setAnchor(anchor);

    // Disposable account + workspace + freemium credits.
    const session = await flux.createSession();

    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: fluxSettings(duration, ratio) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    await finalise(working);

    const assetId = await flux.generate(session, { prompt, duration, ratio });
    idRef.value = assetId;

    // Persist so a crash/kill mid-render can resume (rebuild the session from the
    // refresh token, then keep polling the same asset).
    try {
      await jobStore.save({
        jobId,
        kind: 'flux',
        userId: user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        anchorMessageId: anchor.id,
        prompt,
        duration,
        ratio,
        assetId,
        email: session.email,
        refreshToken: session.refreshToken,
        workspaceId: session.workspaceId,
        deadlineAt: startedAt + VIDEO_TIMEOUT,
        createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist flux job ${jobId}: ${err?.message ?? err}`);
    }

    const { videoUrl } = await flux.waitForAsset(session, assetId, {
      intervalMs: 8000,
      timeoutMs: VIDEO_TIMEOUT,
      onUpdate: () => {},
    });

    const file = await flux.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: [`\`${duration}s\``, `\`${ratio}\``, '`audio on`', `\`${fmtElapsed(Date.now() - startedAt)}\``].join(' \u2022 ') },
          { name: 'Asset ID', value: `\`\`\`${idRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp();
      await finalise(done);

      if (file.bytes >= limit) {
        await replyToAnchor({ content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        console.log(`${idRef.value} (flux) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'flux3-video.mp4' })] });
        console.log(`${idRef.value} (flux) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef, commandName, idLabel: 'Asset ID',
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
    await jobStore.remove(jobId);
  }
}

// ─── Resume after a restart ──────────────────────────────────────────────────
// Jobs are persisted the moment the task is submitted, so a crash / OOM-kill /
// deploy mid-render doesn't lose them: on boot we re-poll each task by its id and
// deliver the result to the original message.

function resumeUser(user, id) {
  if (user) return user;
  return { username: 'user', displayAvatarURL: () => undefined, toString: () => `<@${id}>` };
}

async function resumePendingJobs() {
  let records;
  try { records = await jobStore.list(); }
  catch (err) { console.error('Could not read job store:', err); return; }
  if (!records.length) return;
  console.log(`Resuming ${records.length} pending generation(s) from a previous run\u2026`);
  for (const rec of records) {
    resumeOne(rec).catch((err) => console.error(`Resume of ${rec.jobId} failed:`, err));
  }
}

async function resumeOne(rec) {
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
  const prompt = rec.prompt ?? '';
  const taskIdRef = { value: rec.taskId };
  const { finalise, replyToAnchor, setAnchor } = makeAnchorFns({ channel });
  setAnchor(anchor);

  if (rec.kind === 'flux') {
    await resumeFlux(rec, { user, prompt, channel, finalise, replyToAnchor });
    return;
  }

  if (rec.kind === 'sd2') {
    await resumeSd2(rec, { user, prompt, channel, finalise, replyToAnchor });
    return;
  }

  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new WanError(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef: taskIdRef, commandName: 'WAN 3.0', idLabel: 'Task ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'WAN 3.0' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const { videoUrl } = await wan.waitForTask(rec.taskId, {
      intervalMs: POLL_MS,
      timeoutMs: remaining,
      onUpdate: (out) => { if (out?.task_id) taskIdRef.value = out.task_id; },
    });

    const file = await wan.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'WAN 3.0' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: settingsLine(rec.duration, rec.ratio, rec.resolution, ['`recovered`']) },
          { name: 'Task ID', value: `\`\`\`${taskIdRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      await finalise(done);

      if (file.bytes >= limit) {
        await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        console.log(`${taskIdRef.value} (resumed) succeeded (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'wan3-video.mp4' })] });
        console.log(`${taskIdRef.value} (resumed) succeeded (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef: taskIdRef, commandName: 'WAN 3.0', idLabel: 'Task ID' });
    } catch (fatal) {
      console.error(`Resume ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

async function resumeFlux(rec, { user, prompt, channel, finalise, replyToAnchor }) {
  const idRef = { value: rec.assetId };
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new FluxError(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'FLUX 3', idLabel: 'Asset ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'FLUX 3' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const session = await flux.sessionFromRefresh({ email: rec.email, refreshToken: rec.refreshToken, workspaceId: rec.workspaceId });
    const { videoUrl } = await flux.waitForAsset(session, rec.assetId, { intervalMs: 8000, timeoutMs: remaining, onUpdate: () => {} });

    const file = await flux.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'FLUX 3' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: [`\`${rec.duration}s\``, `\`${rec.ratio}\``, '`audio on`', '`recovered`'].join(' \u2022 ') },
          { name: 'Asset ID', value: `\`\`\`${rec.assetId ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      await finalise(done);

      if (file.bytes >= limit) {
        await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        console.log(`${rec.assetId} (flux resumed) succeeded (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'flux3-video.mp4' })] });
        console.log(`${rec.assetId} (flux resumed) succeeded (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'FLUX 3', idLabel: 'Asset ID' });
    } catch (fatal) {
      console.error(`Resume flux ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

// ─── Resilience ──────────────────────────────────────────────────────────────
client.on('error', (err) => console.error('Client error:', err));
client.on('shardError', (err) => console.error('Shard websocket error:', err));
client.on('shardDisconnect', (event, id) =>
  console.warn(`Shard ${id} disconnected (code ${event?.code ?? '?'}) \u2014 reconnecting\u2026`));
client.on('shardReconnecting', (id) => console.warn(`Shard ${id} reconnecting\u2026`));
client.on('shardResume', (id) => console.log(`Shard ${id} resumed.`));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (ignored, staying up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored, staying up):', err);
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} \u2014 shutting down cleanly\u2026`);
  try { await client.destroy(); } catch (err) { console.error('Error during shutdown:', err); }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Failed to log in to Discord:', err);
  process.exit(1);
});

async function resumeSd2(rec, { user, prompt, channel, finalise, replyToAnchor }) {
  const idRef = { value: rec.taskId };
  const sd2Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new Sd2Error(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.0', idLabel: 'Task ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'Seedance 2.0' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const { videoUrl } = await sd2.waitForTask(rec.taskId, { intervalMs: POLL_MS, timeoutMs: remaining, onUpdate: () => {} });

    const file = await sd2.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'Seedance 2.0' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd2Settings(rec.duration, rec.ratio, rec.resolution, ['`recovered`']) },
          { name: 'Task ID', value: `\`\`\`${rec.taskId ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      await finalise(done);

      if (file.bytes >= limit) {
        await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        console.log(`${rec.taskId} (sd2 resumed) succeeded (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance2-video.mp4' })] });
        console.log(`${rec.taskId} (sd2 resumed) succeeded (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.0', idLabel: 'Task ID' });
    } catch (fatal) {
      console.error(`Resume sd2 ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}
