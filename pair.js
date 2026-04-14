import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

// Helper: remove directory recursively
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// Helper: convert creds.json to Base64 string
function getBase64FromCreds(sessionDir) {
    try {
        const credsPath = sessionDir + '/creds.json';
        if (!fs.existsSync(credsPath)) return null;
        const credsBuffer = fs.readFileSync(credsPath);
        return credsBuffer.toString('base64');
    } catch (error) {
        console.error('Error reading creds.json:', error);
        return null;
    }
}

// Helper: generate session ID with NovaMd~ prefix
function generateSessionId(phoneNumber) {
    // Clean phone number and use timestamp for uniqueness
    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    const timestamp = Date.now();
    return `NovaMd~${cleanNum}_${timestamp}`;
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session_${Date.now()}`);

    // Remove existing session if present
    await removeFile(dirs);

    // Clean the phone number - remove any non-digit characters
    if (!num) {
        return res.status(400).json({ error: 'Phone number is required' });
    }
    num = num.replace(/[^0-9]/g, '');

    // Validate the phone number using awesome-phonenumber
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        return res.status(400).json({ error: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US) without + or spaces.' });
    }
    // Use the international number format (E.164, without '+')
    num = phone.getNumber('e164').replace('+', '');

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            const NovaBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            NovaBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open') {
                    console.log("✅ Connected successfully!");
                    
                    // Generate session ID with NovaMd~ prefix
                    const sessionId = generateSessionId(num);
                    
                    // Get Base64 string from creds.json
                    const base64Creds = getBase64FromCreds(dirs);
                    
                    if (base64Creds) {
                        console.log("📱 Session data extracted successfully");
                        
                        // Send ONLY the session ID and Base64 creds.json to the client
                        if (!res.headersSent) {
                            return res.json({
                                status: 'success',
                                sessionId: sessionId,
                                credsBase64: base64Creds,
                                message: 'Session created successfully'
                            });
                        }
                    } else {
                        console.error("❌ Failed to read creds.json");
                        if (!res.headersSent) {
                            return res.status(500).json({ error: 'Failed to extract session data' });
                        }
                    }
                    
                    // Clean up session after extraction
                    console.log("🧹 Cleaning up session...");
                    await delay(1000);
                    removeFile(dirs);
                    console.log("✅ Session cleaned up");
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new pair code.");
                        if (!res.headersSent) {
                            return res.status(401).json({ error: 'Authentication failed. Please try again.' });
                        }
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        initiateSession();
                    }
                }
            });

            // Handle pairing code request
            if (!NovaBot.authState.creds.registered) {
                await delay(3000);
                const cleanNum = num.replace(/[^\d+]/g, '');
                const finalNum = cleanNum.startsWith('+') ? cleanNum.substring(1) : cleanNum;

                try {
                    let code = await NovaBot.requestPairingCode(finalNum);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log({ num: finalNum, code });
                    
                    // Send pairing code first, session will be sent after connection opens
                    if (!res.headersSent) {
                        res.json({ 
                            status: 'pairing_initiated',
                            pairCode: code,
                            message: 'Use this code to pair your WhatsApp device. Session will be created after successful connection.'
                        });
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    if (!res.headersSent) {
                        res.status(503).json({ error: 'Failed to get pairing code. Please check your phone number and try again.' });
                    }
                }
            }

            NovaBot.ev.on('creds.update', saveCreds);
        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).json({ error: 'Service Unavailable' });
            }
        }
    }

    await initiateSession();
});

// Optional endpoint to decode Base64 creds for verification
router.post('/decode-session', (req, res) => {
    const { base64Creds } = req.body;
    if (!base64Creds) {
        return res.status(400).json({ error: 'Base64 credentials required' });
    }
    
    try {
        const decoded = Buffer.from(base64Creds, 'base64').toString('utf-8');
        const credsJson = JSON.parse(decoded);
        return res.json({
            valid: true,
            creds: credsJson
        });
    } catch (error) {
        return res.status(400).json({ 
            valid: false, 
            error: 'Invalid Base64 string or corrupted credentials' 
        });
    }
});

// Global uncaught exception handler (silent for known errors)
process.on('uncaughtException', (err) => {
    let e = String(err);
    const ignoredErrors = [
        "conflict", "not-authorized", "Socket connection timeout", 
        "rate-overlimit", "Connection Closed", "Timed Out", 
        "Value not found", "Stream Errored", "Stream Errored (restart required)",
        "statusCode: 515", "statusCode: 503"
    ];
    if (ignoredErrors.some(ignored => e.includes(ignored))) return;
    console.log('Caught exception: ', err);
});

export default router;