/**
 * Registers the /sd2-5 and /sd2fast slash commands with Discord.
 * Run once after setup, and again whenever the options below change:
 *   npm run register
 */
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import {
  SD25_DURATIONS,
  SD25_DEFAULT_DURATION,
  SD25_RATIOS,
  SD25_DEFAULT_RATIO,
  SD25_RESOLUTIONS,
  SD25_DEFAULT_RESOLUTION,
  SD25_MAX_IMAGES,
  SD25_MAX_VIDEOS,
  SD2FAST_DURATIONS,
  SD2FAST_DEFAULT_DURATION,
  SD2FAST_RATIOS,
  SD2FAST_DEFAULT_RATIO,
  SD2FAST_MAX_IMAGES,
  SD2FAST_MAX_VIDEOS,
  SD2_MODEL,
  SD2_DURATIONS,
  SD2_DEFAULT_DURATION,
  SD2_RATIOS,
  SD2_DEFAULT_RATIO,
  SD2_MAX_IMAGES,
  SD2_MAX_VIDEOS,
} from './boxverse.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are both required in .env');
  process.exit(1);
}
if (!DISCORD_GUILD_ID) {
  console.error('DISCORD_GUILD_ID is required — the bot is restricted to a single server.');
  process.exit(1);
}

/**
 * /sd2-5 — Seedance 2.5 video.
 * 480p only, 5 or 10 seconds, audio always on.
 * Up to 4 reference images and 1 reference video.
 */
const sd25Builder = new SlashCommandBuilder()
  .setName('sd2-5')
  .setDescription('Generate a video with Seedance 2.5')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('What should the video show?').setRequired(true).setMaxLength(4000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription(`Length in seconds (default ${SD25_DEFAULT_DURATION})`)
      .addChoices(...SD25_DURATIONS.map((d) => ({ name: `${d}s${d === SD25_DEFAULT_DURATION ? ' (default)' : ''}`, value: d }))),
  )
  .addStringOption((o) =>
    o.setName('aspect').setDescription(`Aspect ratio (default ${SD25_DEFAULT_RATIO})`)
      .addChoices(...SD25_RATIOS.map((r) => ({ name: r === SD25_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  )
  .addStringOption((o) =>
    o.setName('resolution').setDescription(`Output resolution (default ${SD25_DEFAULT_RESOLUTION})`)
      .addChoices(...SD25_RESOLUTIONS.map((r) => ({ name: r === SD25_DEFAULT_RESOLUTION ? `${r} (default)` : r, value: r }))),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to ${SD25_MAX_IMAGES})`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img4').setDescription('A fourth reference image (optional)'))
  .addAttachmentOption((o) => o.setName('vid1').setDescription(`Reference video — MP4/MOV (optional, up to ${SD25_MAX_VIDEOS})`));

/**
 * /sd2fast — Seedance 2.0 Fast video.
 * 720p, 5/10/15 seconds, audio always on.
 * Up to 3 reference images and 1 reference video.
 */
const sd2fastBuilder = new SlashCommandBuilder()
  .setName('sd2fast')
  .setDescription('Generate a video with Seedance 2.0 Fast')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('What should the video show?').setRequired(true).setMaxLength(4000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription(`Length in seconds (default ${SD2FAST_DEFAULT_DURATION})`)
      .addChoices(...SD2FAST_DURATIONS.map((d) => ({ name: `${d}s${d === SD2FAST_DEFAULT_DURATION ? ' (default)' : ''}`, value: d }))),
  )
  .addStringOption((o) =>
    o.setName('aspect').setDescription(`Aspect ratio (default ${SD2FAST_DEFAULT_RATIO})`)
      .addChoices(...SD2FAST_RATIOS.map((r) => ({ name: r === SD2FAST_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to ${SD2FAST_MAX_IMAGES})`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'))
  .addAttachmentOption((o) => o.setName('vid1').setDescription(`Reference video — MP4/MOV (optional, up to ${SD2FAST_MAX_VIDEOS})`));

/**
 * /sd2 — Seedance 2.0 video.
 * 480p, 5/10/15 seconds, audio always on.
 * Up to 3 reference images and 1 reference video.
 */
const sd2Builder = new SlashCommandBuilder()
  .setName('sd2')
  .setDescription('Generate a video with Seedance 2.0')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('What should the video show?').setRequired(true).setMaxLength(4000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription(`Length in seconds (default ${SD2_DEFAULT_DURATION})`)
      .addChoices(...SD2_DURATIONS.map((d) => ({ name: `${d}s${d === SD2_DEFAULT_DURATION ? ' (default)' : ''}`, value: d }))),
  )
  .addStringOption((o) =>
    o.setName('aspect').setDescription(`Aspect ratio (default ${SD2_DEFAULT_RATIO})`)
      .addChoices(...SD2_RATIOS.map((r) => ({ name: r === SD2_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to ${SD2_MAX_IMAGES})`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'))
  .addAttachmentOption((o) => o.setName('vid1').setDescription(`Reference video — MP4/MOV (optional, up to ${SD2_MAX_VIDEOS})`));

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const route = Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID);

try {
  const data = await rest.put(route, {
    body: [sd25Builder.toJSON(), sd2fastBuilder.toJSON(), sd2Builder.toJSON()],
  });
  console.log(`Registered ${data.length} command(s) in server ${DISCORD_GUILD_ID}:`);
  for (const c of data) {
    console.log(`  /${c.name} — ${c.description}`);
    for (const o of c.options ?? []) {
      console.log(`      ${o.name}${o.required ? '*' : ''} — ${o.description}`);
    }
  }
  console.log('\nGuild commands appear immediately. Start the bot with: npm start');
} catch (err) {
  console.error('Registration failed:', err);
  process.exit(1);
}
