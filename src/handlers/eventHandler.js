const fs = require('fs');
const path = require('path');

module.exports = (client) => {
    const eventsPath = path.join(__dirname, '..', 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        const event = require(filePath);
        
        if (event.once) {
            client.once(event.name, (...args) => event.execute(...args));
        } else {
            client.on(event.name, (...args) => event.execute(...args));
        }
    }

    // Lavalink raw data handler with synchronized voice state handling
    client.on("raw", async (d) => {
        let synchronizerHandled = false;
        try {
            if (client.voiceHandshakeSynchronizer) {
                synchronizerHandled = await client.voiceHandshakeSynchronizer.handleRawGateway(d);
            }
        } catch (syncErr) {
            // Handshake synchronizer errors must never break the main gateway event stream
        }

        // Single authoritative path enforcement:
        // When VOICE_SERVER_UPDATE is processed by VoiceHandshakeSynchronizer,
        // it authoritatively manages credential merging and Lavalink dispatch.
        // Skipping sendRawData for VOICE_SERVER_UPDATE prevents duplicate REST PATCH
        // writes to Lavalink and eliminates spurious 'Missing sessionId' errors.
        // All other events (VOICE_STATE_UPDATE, CHANNEL_DELETE) continue to sendRawData
        // to maintain library-level mute, deaf, move, and disconnect handling.
        if (d?.t === 'VOICE_SERVER_UPDATE' && synchronizerHandled) {
            return;
        }

        client.lavalink?.sendRawData(d);
    });
}; 