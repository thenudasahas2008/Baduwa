// /shuffle — toggle shuffle mode
const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');
const { flags } = require('../bot/store');

const shuffleState = new Map(); // guildId -> boolean (shuffle on/off)

function isShuffleOn(guildId) {
  return shuffleState.get(String(guildId)) === true;
}

function setShuffle(guildId, on) {
  shuffleState.set(String(guildId), Boolean(on));
}

const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('Toggle shuffle for the queue')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

async function execute(interaction, ctx) {
  const queue = ctx.player.nodes.get(interaction.guild.id);
  if (!queue || (!queue.size && !queue.isPlaying())) {
    return void (await interaction.reply({ content: 'Nothing to shuffle — the queue is empty!', ephemeral: true }));
  }
  const guildId = String(interaction.guild.id);
  const on = !isShuffleOn(guildId);
  shuffleState.set(guildId, on);
  if (on) queue.enableShuffle(true);
  else queue.disableShuffle();
  await interaction.reply(on ? 'Shuffle **on** 🔀 — next songs are random!' : 'Shuffle **off** — queue order restored.');
}

module.exports = { data, execute, isShuffleOn, setShuffle };
