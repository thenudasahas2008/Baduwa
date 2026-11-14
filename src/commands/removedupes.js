const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { ensureDeferred, requirePlayer, safeReply } = require('../utils/interactionHelpers');
const { createActionEmbed } = require('../utils/zyroEmbeds');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('removedupes')
        .setDescription('Removes duplicate tracks from the upcoming queue.'),
    async execute(interaction) {
        const { client } = interaction;
        await ensureDeferred(interaction, { ephemeral: true });

        try {
            const player = await requirePlayer(interaction);
            if (!player) return;

            const tracks = player.queue?.tracks || [];
            if (tracks.length < 2) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'No Duplicates', 'Not enough tracks in queue to contain duplicates.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            const initialCount = tracks.length;
            const seenIdentifiers = new Set();
            const seenKeys = new Set();
            const uniqueTracks = [];

            for (const track of tracks) {
                const ident = track.info?.identifier || track.identifier;
                const titleKey = `${(track.info?.title || '').toLowerCase().trim()}::${(track.info?.author || '').toLowerCase().trim()}`;

                if (ident && seenIdentifiers.has(ident)) continue;
                if (titleKey && titleKey !== '::' && seenKeys.has(titleKey)) continue;

                if (ident) seenIdentifiers.add(ident);
                if (titleKey && titleKey !== '::') seenKeys.add(titleKey);
                uniqueTracks.push(track);
            }

            const removedCount = initialCount - uniqueTracks.length;
            if (removedCount === 0) {
                return await safeReply(interaction, {
                    embeds: [createActionEmbed('info', 'No Duplicates Found', 'There are no duplicate songs in the queue.')],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Replace queue tracks in place
            tracks.length = 0;
            tracks.push(...uniqueTracks);

            logger.cmd(`/removedupes removed ${removedCount} duplicates in guild ${interaction.guildId}`);

            if (typeof client.playerController?.updatePlayer === 'function') {
                client.playerController.updatePlayer(interaction.guildId, { replace: false }).catch(() => {});
            }

            return await safeReply(interaction, {
                embeds: [createActionEmbed('success', 'Duplicates Removed', `Successfully removed \`${removedCount}\` duplicate track${removedCount === 1 ? '' : 's'} from the queue.`)],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error(`Error in /removedupes:`, error?.stack || error);
            return await safeReply(interaction, {
                embeds: [createActionEmbed('error', 'Error', 'An unexpected error occurred while deduplicating queue.')],
                flags: MessageFlags.Ephemeral
            });
        }
    },
};
