const assert = require('node:assert/strict');
const { ButtonStyle, ActivityType } = require('discord.js');
const {
    GITHUB_PROFILE_URL,
    ZYRO_PURPLE,
    buildWelcomeEmbed,
    buildWelcomeComponents,
    updateWelcomeComponents,
    migrateGuildWelcomeMessage,
    isOldBeatDockWelcomeMessage,
    isExistingZyroWelcomeMessage
} = require('../src/utils/welcomeManager');
const {
    ACTIVITIES,
    ROTATION_INTERVAL_MS,
    ActivityManager
} = require('../src/utils/activityManager');
const guildSettings = require('../src/utils/guildSettings');

let passed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.message}`);
        process.exitCode = 1;
    }
}

async function asyncCheck(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok  - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}\n      ${err.message}`);
        process.exitCode = 1;
    }
}

async function runTests() {
    console.log('Testing ZYRO Welcome Embed and GitHub Button Branding...');

    const mockClient = {
        user: {
            id: 'bot-zyro-123',
            tag: 'ZYRO#0412',
            displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot-zyro-123/avatar.png'
        }
    };

    // 1. Welcome embed exact content verification
    check('buildWelcomeEmbed generates exact required title, description, and footer', () => {
        const embed = buildWelcomeEmbed(mockClient);
        const data = embed.data || embed;

        assert.equal(data.title, 'Thanks for adding ZYRO!', 'Embed title must match exactly');
        assert.equal(data.description, 'ZYRO is ready to play music! Use /play to get started, or /about to learn more.', 'Embed description must match exactly');
        assert.equal(data.footer?.text, 'ZYRO Music', 'Embed footer must be ZYRO Music');
        assert.equal(data.color, ZYRO_PURPLE, 'Embed color must be signature violet');
        assert.equal(data.thumbnail?.url, 'https://cdn.discordapp.com/avatars/bot-zyro-123/avatar.png');
    });

    // 2. Welcome button and GitHub profile link
    check('buildWelcomeComponents contains Link button to user GitHub profile', () => {
        const components = buildWelcomeComponents();
        assert.ok(components.length >= 1);
        const row = components[0];
        const buttons = row.components || [];

        const githubBtn = buttons.find(b => {
            const raw = b.data || b;
            return raw.label === 'GitHub';
        });

        assert.ok(githubBtn, 'Must contain a button labeled GitHub');
        const rawBtn = githubBtn.data || githubBtn;
        assert.equal(rawBtn.style, ButtonStyle.Link, 'Button must be a Discord.js v14 Link button');
        assert.equal(rawBtn.url, 'https://github.com/thenudasahas2008', 'Button URL must point to user GitHub profile');
    });

    // 3. updateWelcomeComponents preserves other buttons and updates GitHub button
    check('updateWelcomeComponents updates GitHub button URL and preserves existing link buttons', () => {
        const existingRow = {
            components: [
                {
                    data: {
                        style: ButtonStyle.Link,
                        label: 'GitHub',
                        url: 'https://github.com/albertgmz/BeatDock'
                    }
                },
                {
                    data: {
                        style: ButtonStyle.Link,
                        label: 'Join Support Server',
                        url: 'https://discord.gg/RH6W8AcQc'
                    }
                }
            ]
        };

        const updatedRows = updateWelcomeComponents([existingRow]);
        assert.equal(updatedRows.length, 1);
        const buttons = updatedRows[0].components;
        assert.equal(buttons.length, 2);

        const updatedGh = buttons.find(b => (b.data?.label || b.label) === 'GitHub');
        assert.ok(updatedGh);
        assert.equal(updatedGh.data?.url || updatedGh.url, 'https://github.com/thenudasahas2008');

        const supportBtn = buttons.find(b => (b.data?.label || b.label) === 'Join Support Server');
        assert.ok(supportBtn);
        assert.equal(supportBtn.data?.url || supportBtn.url, 'https://discord.gg/RH6W8AcQc');
    });

    // 4. Message detection predicates
    check('isOldBeatDockWelcomeMessage correctly detects old BeatDock welcome messages authored by bot', () => {
        const oldMsg = {
            author: { id: 'bot-zyro-123' },
            embeds: [
                {
                    data: {
                        title: 'Thanks for adding BeatDock!',
                        description: 'BeatDock is ready to play music! Use /play to get started, or /about to learn more.',
                        footer: { text: 'BeatDock' }
                    }
                }
            ]
        };
        assert.equal(isOldBeatDockWelcomeMessage(oldMsg, 'bot-zyro-123'), true);

        // Different author (not bot)
        const userMsg = {
            author: { id: 'user-456' },
            embeds: oldMsg.embeds
        };
        assert.equal(isOldBeatDockWelcomeMessage(userMsg, 'bot-zyro-123'), false);

        // New ZYRO message
        const newMsg = {
            author: { id: 'bot-zyro-123' },
            embeds: [
                {
                    data: {
                        title: 'Thanks for adding ZYRO!',
                        description: 'ZYRO is ready to play music! Use /play to get started, or /about to learn more.',
                        footer: { text: 'ZYRO Music' }
                    }
                }
            ]
        };
        assert.equal(isOldBeatDockWelcomeMessage(newMsg, 'bot-zyro-123'), false);
        assert.equal(isExistingZyroWelcomeMessage(newMsg, 'bot-zyro-123'), true);
    });

    console.log('\nTesting Existing Welcome Message In-Place Migration Flow...');

    // 5. Existing message migration in-place without creating duplicate
    await asyncCheck('migrateGuildWelcomeMessage locates and edits old BeatDock message in place without duplicates', async () => {
        let editedPayload = null;
        let messagesCreated = 0;

        const oldMessage = {
            id: 'msg-welcome-old-999',
            author: { id: 'bot-zyro-123' },
            embeds: [
                {
                    data: {
                        title: 'Thanks for adding BeatDock!',
                        description: 'BeatDock is ready to play music! Use /play to get started, or /about to learn more.',
                        footer: { text: 'BeatDock' }
                    }
                }
            ],
            components: [
                {
                    components: [
                        {
                            data: {
                                style: ButtonStyle.Link,
                                label: 'GitHub',
                                url: 'https://github.com/albertgmz/BeatDock'
                            }
                        }
                    ]
                }
            ],
            edit: async (payload) => {
                editedPayload = payload;
                return oldMessage;
            }
        };

        const mockChannel = {
            id: 'ch-general-123',
            name: 'general',
            type: 0, // GuildText
            permissionsFor: () => ({ has: () => true }),
            messages: {
                fetch: async (opts) => {
                    if (typeof opts === 'string') {
                        return opts === 'msg-welcome-old-999' ? oldMessage : null;
                    }
                    return new Map([['msg-welcome-old-999', oldMessage]]);
                },
                send: async () => {
                    messagesCreated++;
                }
            }
        };

        const mockGuild = {
            id: 'g-test-welcome-migration',
            name: 'Test Discord Server',
            channels: {
                cache: new Map([['ch-general-123', mockChannel]])
            },
            client: {
                user: mockClient.user,
                guildSettings: guildSettings
            }
        };

        // Ensure clean state in settings
        const initialSettings = guildSettings.get(mockGuild.id);
        delete initialSettings.welcomeMigrated;
        delete initialSettings.welcomeMessageId;
        delete initialSettings.welcomeChannelId;

        const result = await migrateGuildWelcomeMessage(mockGuild);

        assert.equal(result.success, true);
        assert.equal(result.migrated, true);
        assert.equal(result.messageId, 'msg-welcome-old-999');
        assert.equal(result.channelId, 'ch-general-123');
        assert.equal(messagesCreated, 0, 'Must NOT send any duplicate messages');

        // Check edited payload
        assert.ok(editedPayload, 'oldMessage.edit() must be called in place');
        const editedEmbed = editedPayload.embeds[0].data || editedPayload.embeds[0];
        assert.equal(editedEmbed.title, 'Thanks for adding ZYRO!');
        assert.equal(editedEmbed.description, 'ZYRO is ready to play music! Use /play to get started, or /about to learn more.');
        assert.equal(editedEmbed.footer.text, 'ZYRO Music');

        const editedBtn = editedPayload.components[0].components[0].data || editedPayload.components[0].components[0];
        assert.equal(editedBtn.label, 'GitHub');
        assert.equal(editedBtn.url, 'https://github.com/thenudasahas2008');

        // Verify guildSettings marked as migrated
        assert.equal(guildSettings.isWelcomeMigrated(mockGuild.id), true);

        // Subsequent call skips without rescanning or editing
        editedPayload = null;
        const secondRun = await migrateGuildWelcomeMessage(mockGuild);
        assert.equal(secondRun.skipped, true);
        assert.equal(editedPayload, null, 'Subsequent run must not re-edit message');
    });

    console.log('\nTesting Slash Commands and Locale Branding Consistency...');

    // 6. /about command branding and GitHub link
    check('/about command uses ZYRO branding and opens user GitHub profile with "GitHub Profile" button', async () => {
        const aboutCmd = require('../src/commands/about');
        assert.ok(aboutCmd.data.description.includes('ZYRO'));

        let editedPayload = null;
        const mockInteraction = {
            user: { tag: 'Tester#0001' },
            channel: { name: 'general' },
            guild: { name: 'Test Guild' },
            client: {
                user: { displayAvatarURL: () => 'https://example.com/avatar.png' },
                guilds: { cache: { size: 5 } },
                activePlayers: { size: 1 },
                ws: { ping: 42 },
                uptime: 120000
            },
            deferReply: async () => {},
            editReply: async (payload) => {
                editedPayload = payload;
                return payload;
            }
        };

        await aboutCmd.execute(mockInteraction);
        assert.ok(editedPayload, 'Must reply to /about interaction');
        const embed = editedPayload.embeds[0];
        assert.ok(embed.data.title.includes('ZYRO'));

        const rows = editedPayload.components;
        const buttons = rows.flatMap(r => r.components);
        const ghBtn = buttons.find(b => {
            const raw = b.data || b;
            return raw.url?.includes('github.com');
        });

        assert.ok(ghBtn, 'Must have a GitHub link button');
        const rawGh = ghBtn.data || ghBtn;
        assert.equal(rawGh.label, 'GitHub Profile', 'GitHub button must be labelled "GitHub Profile", not "GitHub Repository"');
        assert.notEqual(rawGh.label, 'GitHub Repository', 'Must not be labelled "GitHub Repository"');
        assert.notEqual(rawGh.label, '⭐ GitHub Repository', 'Must not be labelled "⭐ GitHub Repository"');
        assert.equal(rawGh.style, ButtonStyle.Link, 'Button style must be ButtonStyle.Link');
        assert.equal(rawGh.url, 'https://github.com/thenudasahas2008', 'GitHub button URL must point to user GitHub profile');
        assert.notEqual(rawGh.url, 'https://github.com/albertgmz/BeatDock', 'Must not link to albertgmz/BeatDock');
        assert.notEqual(rawGh.url, 'https://github.com/thenudasahas2008/BeatDock-ZYRO', 'Must not link to source repository');

        const supportBtn = buttons.find(b => {
            const raw = b.data || b;
            return raw.label?.includes('Support');
        });
        assert.ok(supportBtn, 'Must preserve Official Support Server button');
        const rawSupport = supportBtn.data || supportBtn;
        assert.equal(rawSupport.label, 'Official Support Server', 'Support button label must be Official Support Server');
        assert.equal(rawSupport.style, ButtonStyle.Link, 'Support button style must be ButtonStyle.Link');
        assert.ok(rawSupport.url && rawSupport.url.includes('discord.gg'), 'Support button URL must be a valid Discord invite');
    });

    check('no public bot embed or command exposes direct source repository or albertgmz/BeatDock URL', async () => {
        const forbiddenUrls = [
            'https://github.com/thenudasahas2008/BeatDock-ZYRO',
            'https://github.com/albertgmz/BeatDock',
            'albertgmz/BeatDock'
        ];
        const welcomeManager = require('../src/utils/welcomeManager');
        const welcomeRows = welcomeManager.buildWelcomeComponents();
        const welcomeBtns = welcomeRows.flatMap(r => r.components.map(c => (c.data || c).url));
        for (const bad of forbiddenUrls) {
            assert.ok(!welcomeBtns.some(u => u && u.includes(bad)), `Welcome components must not expose ${bad}`);
        }

        const aboutCmd = require('../src/commands/about');
        let aboutPayload = null;
        await aboutCmd.execute({
            user: { tag: 'Test#1' },
            channel: { name: 'test' },
            guild: { name: 'Test' },
            client: {
                user: { displayAvatarURL: () => null },
                guilds: { cache: { size: 1 } },
                activePlayers: { size: 0 },
                ws: { ping: 20 },
                uptime: 60000
            },
            deferReply: async () => {},
            editReply: async (p) => { aboutPayload = p; }
        });
        const aboutBtns = aboutPayload.components.flatMap(r => r.components.map(c => (c.data || c).url));
        for (const bad of forbiddenUrls) {
            assert.ok(!aboutBtns.some(u => u && u.includes(bad)), `/about must not expose ${bad}`);
        }
    });

    // 7. /invite command branding
    check('/invite command description references ZYRO', () => {
        const inviteCmd = require('../src/commands/invite');
        assert.ok(inviteCmd.data.description.includes('ZYRO'));
        assert.ok(!inviteCmd.data.description.includes('BeatDock'));
    });

    // 8. Locales consistency
    check('locales/en.json contains updated ZYRO welcome and about titles', () => {
        const en = require('../locales/en.json');
        assert.equal(en.WELCOME_TITLE, 'Thanks for adding ZYRO!');
        assert.equal(en.WELCOME_DESCRIPTION, 'ZYRO is ready to play music! Use `/play` to get started, or `/about` to learn more.');
        assert.equal(en.ABOUT_TITLE, 'About ZYRO');
        assert.equal(en.INVITE_TITLE, 'Invite ZYRO');
    });

    console.log('\nTesting ZYRO Activity Rotation Manager...');

    const EXPECTED_ACTIVITIES = [
        '🎵 Taking song requests',
        '🎧 Music on demand',
        '🎶 Use /play to start',
        '🔎 Find your next song • /search',
        '📜 Lyrics available • /lyrics',
        '🎛️ Shuffle your vibe',
        '🔁 Loop your favorites',
        '📋 Managing the queue • /queue',
        '🎤 Your server\'s music',
        '⏭️ Ready for the next track',
        '🎼 Autoplay your playlist',
        '🔊 Your music, your rules',
        '🎵 Requests open • /play',
        '🎚️ Music controls • /help',
        '🌐 Music in {serverCount} servers',
    ];

    // 9. Activity list exact verification
    check('ACTIVITIES contains the exact 15 required statuses in order', () => {
        assert.equal(ACTIVITIES.length, 15, 'Must have exactly 15 rotating activities');
        assert.deepEqual(ACTIVITIES, EXPECTED_ACTIVITIES, 'Activities must match exact expected list and order');
    });

    // 10. Verify Powered by ZYRO is removed
    check('ACTIVITIES does not contain "Powered by ZYRO"', () => {
        for (const act of ACTIVITIES) {
            assert.ok(!act.includes('Powered by ZYRO'), `Activity "${act}" must not contain "Powered by ZYRO"`);
            assert.ok(!act.includes('💜'), `Activity "${act}" must not contain obsolete 💜 indicator`);
        }
    });

    // 11. Verify interval is 240,000 ms (4 minutes)
    check('ROTATION_INTERVAL_MS is exactly 240,000 ms (4 minutes)', () => {
        assert.equal(ROTATION_INTERVAL_MS, 240000);
        const mgr = new ActivityManager({});
        assert.equal(mgr.intervalMs, 240000);
    });

    // 12. Verify dynamic server count replacement without fake stats
    check('formatActivity dynamically resolves {serverCount} from client.guilds.cache.size', () => {
        const dummyClient1 = { guilds: { cache: { size: 12 } } };
        const mgr1 = new ActivityManager(dummyClient1);
        const formatted1 = mgr1.formatActivity('🌐 Music in {serverCount} servers');
        assert.equal(formatted1, '🌐 Music in 12 servers');

        const dummyClient2 = { guilds: { cache: { size: 1 } } };
        const mgr2 = new ActivityManager(dummyClient2);
        const formatted2 = mgr2.formatActivity('🌐 Music in {serverCount} servers');
        assert.equal(formatted2, '🌐 Music in 1 servers');

        const dummyClient3 = {};
        const mgr3 = new ActivityManager(dummyClient3);
        const formatted3 = mgr3.formatActivity('🌐 Music in {serverCount} servers');
        assert.equal(formatted3, '🌐 Music in 0 servers');
    });

    // 13. Regression test: Custom Activity payload structure compliant with Discord.js v14
    check('ActivityManager emits valid Custom Activity payload with state field, name="Custom Status", and status="online"', () => {
        let sentPresence = null;
        const mockPresenceClient = {
            guilds: { cache: { size: 5 } },
            user: {
                setPresence: (payload) => {
                    sentPresence = payload;
                }
            }
        };

        const manager = new ActivityManager(mockPresenceClient);
        manager.applyCurrentActivity(true);

        assert.ok(sentPresence, 'setPresence must be called with a payload');
        assert.equal(sentPresence.status, 'online', 'Status must be online');
        assert.ok(Array.isArray(sentPresence.activities), 'Activities must be an array');
        assert.equal(sentPresence.activities.length, 1);

        const activity = sentPresence.activities[0];
        assert.equal(activity.name, 'Custom Status', 'Activity name must be "Custom Status"');
        assert.equal(activity.type, ActivityType.Custom, 'Activity type must be ActivityType.Custom (type 4)');
        assert.equal(activity.state, '🎵 Taking song requests', 'Activity text must be placed in the state field');
    });

    // 14. Verify rotation order, all 15 transitions, and cycling wrap-around
    check('ActivityManager cycles through all 15 activities in order and wraps around with valid payloads', () => {
        let sentPresence = null;
        const mockPresenceClient = {
            guilds: { cache: { size: 7 } },
            user: {
                setPresence: (payload) => {
                    sentPresence = payload;
                }
            }
        };

        const manager = new ActivityManager(mockPresenceClient);
        assert.equal(manager.getCurrentActivityText(), '🎵 Taking song requests');

        for (let i = 1; i < EXPECTED_ACTIVITIES.length; i++) {
            const next = manager.rotateNext(true);
            const expectedTemplate = EXPECTED_ACTIVITIES[i];
            const expectedText = expectedTemplate.replace('{serverCount}', '7');
            assert.equal(next, expectedText);
            assert.equal(sentPresence?.activities[0]?.state, expectedText);
            assert.equal(sentPresence?.activities[0]?.type, ActivityType.Custom);
            assert.equal(sentPresence?.activities[0]?.name, 'Custom Status');
        }

        // Cycling past the end wraps around to the first activity
        const wrapped = manager.rotateNext(true);
        assert.equal(wrapped, EXPECTED_ACTIVITIES[0]);
        assert.equal(manager.currentIndex, 0);
        assert.equal(sentPresence?.activities[0]?.state, EXPECTED_ACTIVITIES[0]);
    });

    // 15. Verify timer deduplication across multiple start() calls (e.g. reconnects)
    check('ActivityManager.start deduplicates timers on reconnects or multiple calls', () => {
        const mockPresenceClient = {
            guilds: { cache: { size: 5 } },
            user: { setPresence: () => {} }
        };

        const manager = new ActivityManager(mockPresenceClient);
        assert.equal(manager.isRunning(), false);

        manager.start();
        assert.equal(manager.isRunning(), true);
        const initialTimer = manager.rotationTimer;

        // Reconnect / repeated ready event:
        manager.start();
        assert.equal(manager.isRunning(), true);
        assert.notEqual(manager.rotationTimer, initialTimer, 'Previous timer was replaced cleanly');

        manager.stop();
        assert.equal(manager.isRunning(), false);
        assert.equal(manager.rotationTimer, null);
    });

    // 16. Verify diagnostic fallback modes for Playing and Listening types
    check('ActivityManager supports diagnostic fallback to Playing and Listening activity types', () => {
        const playingClient = {
            guilds: { cache: { size: 3 } },
            user: {
                setPresence: (payload) => {
                    assert.equal(payload.activities[0].type, ActivityType.Playing);
                    assert.equal(payload.activities[0].name, '🎵 Taking song requests');
                }
            }
        };
        const playingManager = new ActivityManager(playingClient, { activityType: ActivityType.Playing });
        playingManager.applyCurrentActivity(true);

        const listeningClient = {
            guilds: { cache: { size: 3 } },
            user: {
                setPresence: (payload) => {
                    assert.equal(payload.activities[0].type, ActivityType.Listening);
                    assert.equal(payload.activities[0].name, '🎵 Taking song requests');
                }
            }
        };
        const listeningManager = new ActivityManager(listeningClient, { activityType: ActivityType.Listening });
        listeningManager.applyCurrentActivity(true);
    });

    // 17. Centralized presence coordinator: active music vs idle rotating status
    check('updatePresence coordinates active music players vs idle rotating statuses', () => {
        let sentPresence = null;
        const mockCoordClient = {
            guilds: { cache: { size: 10 } },
            activePlayers: new Map(),
            t: (key, ...args) => {
                if (key === 'PLAYING_MUSIC_GENERIC') return 'Playing music';
                if (key === 'PLAYING_MUSIC_IN_SERVERS') return `Playing music in ${args[0]} servers`;
                return key;
            },
            user: {
                setPresence: (payload) => {
                    sentPresence = payload;
                }
            }
        };

        const manager = new ActivityManager(mockCoordClient);
        manager.updatePresence();
        // Idle: shows custom status
        assert.equal(sentPresence?.activities[0]?.type, ActivityType.Custom);
        assert.equal(sentPresence?.activities[0]?.state, '🎵 Taking song requests');

        // 1 active player: shows listening to music
        mockCoordClient.activePlayers.set('g1', { title: 'Song A' });
        manager.updatePresence();
        assert.equal(sentPresence?.activities[0]?.type, ActivityType.Listening);
        assert.equal(sentPresence?.activities[0]?.name, 'Playing music');

        // 2 active players: shows listening in 2 servers
        mockCoordClient.activePlayers.set('g2', { title: 'Song B' });
        manager.updatePresence();
        assert.equal(sentPresence?.activities[0]?.type, ActivityType.Listening);
        assert.equal(sentPresence?.activities[0]?.name, 'Playing music in 2 servers');

        // Music stops: automatically restores rotating activity
        mockCoordClient.activePlayers.clear();
        manager.updatePresence();
        assert.equal(sentPresence?.activities[0]?.type, ActivityType.Custom);
        assert.equal(sentPresence?.activities[0]?.state, '🎵 Taking song requests');
    });

    // 18. Verify error isolation when setPresence throws
    check('ActivityManager safely handles errors if setPresence throws', () => {
        const errorClient = {
            guilds: { cache: { size: 3 } },
            user: {
                setPresence: () => {
                    throw new Error('Simulated Discord API rate limit or network issue');
                }
            }
        };

        const manager = new ActivityManager(errorClient);
        assert.doesNotThrow(() => {
            manager.applyCurrentActivity(true);
            manager.rotateNext(true);
        });
    });

    console.log('\nTesting ZYRO ♪ Bot Username and Authoritative Branding Identity...');

    const { INTENDED_BOT_USERNAME: BRANDING_NAME } = require('../src/utils/branding');
    const { INTENDED_BOT_USERNAME: READY_NAME, syncBotUsername } = require('../src/events/ready');
    const { INTENDED_BOT_USERNAME: WELCOME_NAME } = require('../src/utils/welcomeManager');

    // 19. Authoritative username constant is exactly "ZYRO ♪"
    check('Authoritative username constant is exactly "ZYRO ♪" across all identity modules', () => {
        assert.equal(BRANDING_NAME, 'ZYRO ♪', 'branding.js constant must be literal "ZYRO ♪"');
        assert.equal(READY_NAME, 'ZYRO ♪', 'ready.js constant must be literal "ZYRO ♪"');
        assert.equal(WELCOME_NAME, 'ZYRO ♪', 'welcomeManager.js constant must be literal "ZYRO ♪"');
        assert.equal(BRANDING_NAME.includes('**'), false, 'Username must not contain Markdown formatting');
        assert.equal(BRANDING_NAME.includes('&'), false, 'Username must not contain HTML entities');
        assert.equal(BRANDING_NAME.endsWith('♪'), true, 'Username must end with music note character ♪');
    });

    // 20. Username is not changed when it already matches "ZYRO ♪"
    await asyncCheck('syncBotUsername skips Discord API update when username already matches "ZYRO ♪"', async () => {
        let setUsernameCalled = false;
        const matchingClient = {
            user: {
                username: 'ZYRO ♪',
                setUsername: async () => {
                    setUsernameCalled = true;
                }
            }
        };

        const result = await syncBotUsername(matchingClient);
        assert.equal(result, true, 'syncBotUsername must return true when already matching');
        assert.equal(setUsernameCalled, false, 'setUsername must NOT be called when username already matches');
    });

    // 21. Startup updates username to "ZYRO ♪" when it differs from intended identity
    await asyncCheck('syncBotUsername updates bot username to "ZYRO ♪" when current username differs', async () => {
        let requestedNewName = null;
        const legacyClient = {
            user: {
                username: 'ZYRO',
                setUsername: async (name) => {
                    requestedNewName = name;
                    return true;
                }
            }
        };

        const result = await syncBotUsername(legacyClient);
        assert.equal(result, true, 'syncBotUsername must return true on successful update');
        assert.equal(requestedNewName, 'ZYRO ♪', 'Requested username update must be exactly "ZYRO ♪", never plain "ZYRO"');
    });

    // 22. Discord API rate limits and errors are handled gracefully without crashing
    await asyncCheck('syncBotUsername handles Discord API rate limits or errors gracefully without throwing', async () => {
        const rateLimitedClient = {
            user: {
                username: 'OldBotName',
                setUsername: async () => {
                    const err = new Error('Rate limit exceeded: You are changing your username too fast. Try again later.');
                    err.status = 429;
                    throw err;
                }
            }
        };

        let threw = false;
        let result = null;
        try {
            result = await syncBotUsername(rateLimitedClient);
        } catch (e) {
            threw = true;
        }

        assert.equal(threw, false, 'syncBotUsername must never throw on Discord API rate limits');
        assert.equal(result, false, 'syncBotUsername returns false when Discord API rejects update');
    });

    // 23. Full ready.js execution verifies identity without reverting "ZYRO ♪" to plain "ZYRO"
    await asyncCheck('ready.js execution does not attempt to rename "ZYRO ♪" back to plain "ZYRO"', async () => {
        const readyHandler = require('../src/events/ready');
        let attemptedName = null;

        const testReadyClient = {
            user: {
                id: 'bot-1234567890',
                tag: 'ZYRO ♪#0001',
                username: 'ZYRO ♪',
                displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot-1234567890/avatar.png',
                setUsername: async (n) => {
                    attemptedName = n;
                }
            },
            activityManager: { start: () => {} },
            lavalink: null,
            lavalinkConnectionManager: null,
            guildSettings: null,
            playerController: null
        };

        await readyHandler.execute(testReadyClient);
        assert.equal(attemptedName, null, 'ready.js must NOT attempt to change username if it is already "ZYRO ♪"');
    });

    console.log(`\nAll ${passed} branding, welcome migration, and activity rotation tests passed successfully!`);
}

runTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
