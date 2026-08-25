/**
 * Registers the /flux-3 and /sd2 slash commands with Discord.
 * Run once after setup, and again whenever the options below change:
 *   npm run register
 */
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import {
  FLUX_DURATIONS,
  FLUX_DEFAULT_DURATION,
  FLUX_RATIOS,
  FLUX_DEFAULT_RATIO,
} from './flux.js';
import {
  SD2_DURATIONS,
  SD2_DEFAULT_DURATION,
  SD2_RESOLUTIONS,
  SD2_DEFAULT_RESOLUTION,
  SD2_RATIOS,
  SD2_DEFAULT_RATIO,
  SD2_MAX_IMAGES,
  SD2_MAX_VIDEOS,
} from './sd2.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are both required in .env');
  process.exit(1);
}
if (!DISCORD_GUILD_ID) {
  console.error('DISCORD_GUILD_ID is required \u2014 the bot is restricted to a single server.');
  process.exit(1);
}

/**
 * /flux-3 \u2014 FLUX 3 video via Synthesia (disposable account per run).
 * prompt, duration (5/10/15/20s), ratio (16:9 / 9:16). Audio always on.
 */
const flux3Builder = new SlashCommandBuilder()
  .setName('flux-3')
  .setDescription('Generate a video with FLUX 3')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('What should the video show?').setRequired(true).setMaxLength(4000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription(`Length in seconds (default ${FLUX_DEFAULT_DURATION})`)
      .addChoices(...FLUX_DURATIONS.map((d) => ({ name: `${d}s${d === FLUX_DEFAULT_DURATION ? ' (default)' : ''}`, value: d }))),
  )
  .addStringOption((o) =>
    o.setName('ratio').setDescription(`Aspect ratio (default ${FLUX_DEFAULT_RATIO})`)
      .addChoices(...FLUX_RATIOS.map((r) => ({ name: r === FLUX_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  );

/**
 * /sd2 \u2014 Seedance 2.0 video via Volcengine ARK.
 * prompt, duration (5/10/15s), resolution (480p/720p), ratio (16:9/9:16/21:9/4:3),
 * up to 3 reference images and 1 reference video.
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
    o.setName('resolution').setDescription(`Output resolution (default ${SD2_DEFAULT_RESOLUTION})`)
      .addChoices(...SD2_RESOLUTIONS.map((r) => ({ name: r === SD2_DEFAULT_RESOLUTION ? `${r} (default)` : r, value: r }))),
  )
  .addStringOption((o) =>
    o.setName('ratio').setDescription(`Aspect ratio (default ${SD2_DEFAULT_RATIO})`)
      .addChoices(...SD2_RATIOS.map((r) => ({ name: r === SD2_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to ${SD2_MAX_IMAGES})`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'))
  .addAttachmentOption((o) => o.setName('vid1').setDescription(`Reference video \u2014 MP4/MOV (optional, up to ${SD2_MAX_VIDEOS})`));

/**
 * /autobypass \u2014 fires 4 Seedance 2.0 renders with the intro clip as the
 * reference video, waits for all of them, then judges with ffmpeg which render
 * has the least intro and delivers that one trimmed to the scene.
 * 15s \u2022 16:9 \u2022 720p, no user references.
 */
const autobypassBuilder = new SlashCommandBuilder()
  .setName('autobypass')
  .setDescription('Fire 4 renders of your prompt and deliver the cleanest one, intro trimmed')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('The scene the video should cut to after the intro').setRequired(true).setMaxLength(3000),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to 3) \u2014 passed as a reference, not a first frame`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'));

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const route = Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID);

try {
  const data = await rest.put(route, { body: [flux3Builder.toJSON(), sd2Builder.toJSON(), autobypassBuilder.toJSON()] });
  console.log(`Registered ${data.length} command(s) in server ${DISCORD_GUILD_ID}:`);
  for (const c of data) {
    console.log(`  /${c.name} \u2014 ${c.description}`);
    for (const o of c.options ?? []) {
      console.log(`      ${o.name}${o.required ? '*' : ''} \u2014 ${o.description}`);
    }
  }
  console.log('\nGuild commands appear immediately. Start the bot with: npm start');
} catch (err) {
  console.error('Registration failed:', err);
  process.exit(1);
}
