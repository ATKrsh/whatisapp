const path = require('path');
const fs = require('fs');

let userDataPath;
if (process.versions.electron) {
    const { app } = require('electron');
    userDataPath = app.getPath('userData');
} else {
    userDataPath = __dirname;
}

// Ensure the userDataPath directory exists
if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
}

// Load env from userDataPath if it exists, otherwise fall back to local
const envPath = path.join(userDataPath, '.env');
if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
} else {
    require('dotenv').config();
}

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const geminiService = require('./gemini-service');

// --- Express & HTTP Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- SQLite Database Setup ---
const dbPath = path.join(userDataPath, 'chat_replier.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Database connection error:", err);
    } else {
        console.log("Connected to SQLite database.");
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.run(`CREATE TABLE IF NOT EXISTS chat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT,
        contact_name TEXT,
        message TEXT,
        reply TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_group INTEGER,
        is_auto INTEGER,
        status TEXT,
        error TEXT
    )`);
}

// --- Configuration Management ---
const configPath = path.join(userDataPath, 'config.json');
let systemConfig = {
    autoReply: true,
    geminiModel: "gemini-1.5-flash",
    basePrompt: "You are an AI assistant representing the user. Answer incoming WhatsApp messages politely, helpfully, and concisely (under three sentences). Maintain a friendly yet professional tone.",
    whitelist: [],
    blacklist: [],
    restrictToWhitelist: false,
    llmProvider: "gemini",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "llama3"
};

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const fileData = fs.readFileSync(configPath, 'utf8');
            systemConfig = { ...systemConfig, ...JSON.parse(fileData) };
            console.log("Configuration loaded from config.json");
        } else {
            saveConfig();
        }
    } catch (error) {
        console.error("Error loading config.json, using defaults:", error);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(systemConfig, null, 2), 'utf8');
    } catch (error) {
        console.error("Failed to save config.json:", error);
    }
}

function saveEnvKey(apiKey) {
    try {
        const envPath = path.join(userDataPath, '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }
        
        // If GEMINI_API_KEY exists in .env, replace it. Otherwise, append it.
        if (envContent.includes('GEMINI_API_KEY=')) {
            envContent = envContent.replace(/GEMINI_API_KEY=.*/g, `GEMINI_API_KEY=${apiKey}`);
        } else {
            envContent += `\nGEMINI_API_KEY=${apiKey}`;
        }
        
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log("API Key successfully written to .env file");
    } catch (error) {
        console.error("Failed to write API key to .env:", error);
    }
}

// Initialize AI Service
loadConfig();
const geminiKey = process.env.GEMINI_API_KEY;
const activeModel = systemConfig.llmProvider === 'ollama' ? systemConfig.ollamaModel : systemConfig.geminiModel;
geminiService.initialize(
    geminiKey,
    activeModel,
    systemConfig.basePrompt,
    systemConfig.llmProvider,
    systemConfig.ollamaUrl
);
console.log(`AI Service initialized with provider: ${systemConfig.llmProvider}`);

// --- WhatsApp Client Initialization ---
let clientState = 'DISCONNECTED'; // DISCONNECTED, SCANNING_QR, SYNCING, CONNECTED
let currentQrCode = '';
let client = null;

async function initializeWhatsAppClient() {
    console.log("Initializing WhatsApp Client...");
    
    // Find the best available browser - system Chrome/Edge is most reliable in packaged apps
    let execPath = '';
    const browserPaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const p of browserPaths) {
        if (fs.existsSync(p)) {
            execPath = p;
            console.log(`Found browser at: ${execPath}`);
            break;
        }
    }
    
    // Fallback to puppeteer's bundled chromium if no system browser found
    if (!execPath) {
        try {
            const ppt = require('puppeteer');
            const pathResult = ppt.executablePath();
            const raw = pathResult instanceof Promise ? await pathResult : pathResult;
            const unpacked = raw ? raw.replace('app.asar', 'app.asar.unpacked') : '';
            if (unpacked && fs.existsSync(unpacked)) {
                execPath = unpacked;
                console.log(`Using bundled Chromium at: ${execPath}`);
            }
        } catch(e) {
            console.log("Puppeteer bundled chromium not available:", e.message);
        }
    }

    if (!execPath) {
        console.error("FATAL: No browser found. Please install Google Chrome.");
        broadcastState();
        return;
    }

    // Launch whatsapp-web.js with confirmed browser path
    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(userDataPath, '.wwebjs_auth')
        }),
        puppeteer: {
            headless: true,
            executablePath: execPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', (qr) => {
        clientState = 'SCANNING_QR';
        currentQrCode = qr;
        qrcodeTerminal.generate(qr, { small: true });
        broadcastState();
    });

    client.on('ready', () => {
        clientState = 'CONNECTED';
        currentQrCode = '';
        console.log('WhatsApp Client is ready and connected!');
        broadcastState();
    });

    client.on('auth_failure', (msg) => {
        clientState = 'DISCONNECTED';
        currentQrCode = '';
        console.error('WhatsApp Authentication failure:', msg);
        broadcastState();
    });

    client.on('disconnected', (reason) => {
        clientState = 'DISCONNECTED';
        currentQrCode = '';
        console.log('WhatsApp Client was disconnected:', reason);
        broadcastState();
        
        // Destroy and reinitialize to prevent hanging
        client.destroy().then(() => {
            initializeWhatsAppClient();
        });
    });

    // --- Message Processing & Auto-Reply Rules ---
    // Track message counts per user to prevent infinite loops and spamming
    const userMessageTracker = new Map(); // contactId -> { count, lastTime }

    client.on('message', async (msg) => {
        try {
            const chat = await msg.getChat();
            const contact = await msg.getContact();
            const contactId = msg.from;
            const contactName = contact.pushname || chat.name || contact.number || "Unknown";
            const isGroup = chat.isGroup ? 1 : 0;
            const messageBody = msg.body;

            // Log details
            console.log(`Received message from ${contactName} (${contactId}): "${messageBody}"`);

            // Apply Failsafes and Rules
            
            // Rule 1: Ignore group messages by default to prevent reply loops
            if (isGroup) {
                logMessage(contactId, contactName, messageBody, null, 1, 0, 'IGNORED_GROUP', null);
                return;
            }

            // Rule 2: Ignore system/broadcast messages
            if (contactId === 'status@broadcast') {
                return;
            }

            // Rule 3: Check global autoReply toggle
            if (!systemConfig.autoReply) {
                logMessage(contactId, contactName, messageBody, null, 0, 0, 'AUTO_REPLY_DISABLED', null);
                return;
            }

            // Rule 4: Whitelist / Blacklist validation
            const isBlacklisted = systemConfig.blacklist.includes(contact.number);
            const isWhitelisted = systemConfig.whitelist.includes(contact.number);

            if (isBlacklisted) {
                logMessage(contactId, contactName, messageBody, null, 0, 0, 'BLACKLISTED', null);
                return;
            }

            if (systemConfig.restrictToWhitelist && !isWhitelisted) {
                logMessage(contactId, contactName, messageBody, null, 0, 0, 'NOT_IN_WHITELIST', null);
                return;
            }

            // Rule 5: Rate Limiting & Loop Failsafes
            const now = Date.now();
            let tracker = userMessageTracker.get(contactId) || { count: 0, lastTime: 0 };
            
            // Reset tracker count if last message was more than an hour ago
            if (now - tracker.lastTime > 3600000) {
                tracker.count = 0;
            }

            // Block if message rate is too fast (more than 1 message per 10 seconds)
            if (now - tracker.lastTime < 10000) {
                console.log(`Rate-limit trigger: Ignored fast consecutive message from ${contactName}`);
                logMessage(contactId, contactName, messageBody, null, 0, 0, 'RATE_LIMITED', 'Too many fast requests');
                return;
            }

            // Block if spam limit exceeded (more than 20 messages per hour)
            if (tracker.count >= 20) {
                console.log(`Spam prevention: Whitelist cap reached for ${contactName}`);
                logMessage(contactId, contactName, messageBody, null, 0, 0, 'SPAM_PREVENTED', 'Exceeded 20 messages per hour');
                return;
            }

            // Update tracker
            tracker.count++;
            tracker.lastTime = now;
            userMessageTracker.set(contactId, tracker);

            // Rule 6: Check AI Service Status
            if (systemConfig.llmProvider === 'gemini' && !geminiService.genAI) {
                console.warn("Auto-reply skipped: Gemini API key is missing/unconfigured.");
                logMessage(contactId, contactName, messageBody, null, 0, 0, 'ERROR_KEY_MISSING', 'API key unconfigured');
                return;
            }

            // Execute AI reply generation
            console.log(`Generating AI reply for ${contactName}...`);

            // Step 1: Small "read delay" to look natural but not slow (100-300ms)
            const readDelayMs = 100 + Math.floor(Math.random() * 200);
            console.log(`Simulating read delay for ${readDelayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, readDelayMs));

            // Step 2: Show typing indicator WHILE the AI generates the reply
            if (chat && typeof chat.sendStateTyping === 'function') {
                try {
                    await chat.sendStateTyping();
                } catch (e) {
                    console.warn("Could not send typing state:", e.message);
                }
            }

            const replyText = await geminiService.generateReply(contactId, messageBody);

            // Step 3: Small typing delay (100-300ms)
            const typingDelayMs = 100 + Math.floor(Math.random() * 200);
            console.log(`Simulating typing for ${typingDelayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, typingDelayMs));

            // Send Reply back to WhatsApp
            await msg.reply(replyText);
            console.log(`Replied to ${contactName}: "${replyText}"`);

            // Save log to SQLite and notify UI
            logMessage(contactId, contactName, messageBody, replyText, 0, 1, 'SUCCESS', null);

        } catch (error) {
            console.error("Error processing message:", error);
            const contact = await msg.getContact().catch(() => ({ pushname: "Unknown" }));
            logMessage(msg.from, contact.pushname || "Unknown", msg.body, null, 0, 0, 'ERROR', error.message);
        }
    });

    client.initialize();
}

// Save log helper
function logMessage(contactId, contactName, message, reply, isGroup, isAuto, status, error) {
    db.run(`INSERT INTO chat_logs (contact_id, contact_name, message, reply, is_group, is_auto, status, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [contactId, contactName, message, reply, isGroup, isAuto, status, error],
        function(err) {
            if (err) {
                console.error("Failed to insert log in database:", err);
            } else {
                // Broadcast new log to all WebSocket clients
                broadcast({
                    type: 'NEW_LOG',
                    log: {
                        id: this.lastID,
                        contact_id: contactId,
                        contact_name: contactName,
                        message: message,
                        reply: reply,
                        timestamp: new Date().toISOString(),
                        is_group: isGroup,
                        is_auto: isAuto,
                        status: status,
                        error: error
                    }
                });
            }
        }
    );
}

// --- WebSocket Broadcast Helper ---
function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(wsClient => {
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(message);
        }
    });
}

function broadcastState() {
    broadcast({
        type: 'STATUS_SYNC',
        state: {
            clientState: clientState,
            hasQr: !!currentQrCode,
            qrData: currentQrCode,
            llmProvider: systemConfig.llmProvider || 'gemini',
            geminiActive: systemConfig.llmProvider === 'ollama' ? true : !!geminiService.genAI,
            autoReply: systemConfig.autoReply
        }
    });
}

// WebSocket Connection Handler
wss.on('connection', (ws) => {
    console.log("Websocket Client connected.");
    
    // Sync current status immediately
    ws.send(JSON.stringify({
        type: 'STATUS_SYNC',
        state: {
            clientState: clientState,
            hasQr: !!currentQrCode,
            qrData: currentQrCode,
            llmProvider: systemConfig.llmProvider || 'gemini',
            geminiActive: systemConfig.llmProvider === 'ollama' ? true : !!geminiService.genAI,
            autoReply: systemConfig.autoReply
        }
    }));

    // Send latest 30 logs to new client
    db.all(`SELECT * FROM chat_logs ORDER BY timestamp DESC LIMIT 30`, (err, rows) => {
        if (!err && rows) {
            ws.send(JSON.stringify({
                type: 'INITIAL_LOGS',
                logs: rows.reverse()
            }));
        }
    });
});

// --- REST API Endpoints ---

// Get current config
app.get('/api/config', (req, res) => {
    res.json(systemConfig);
});

// Update config
app.post('/api/config', (req, res) => {
    const { 
        autoReply, 
        geminiModel, 
        basePrompt, 
        whitelist, 
        blacklist, 
        restrictToWhitelist, 
        apiKey,
        llmProvider,
        ollamaUrl,
        ollamaModel
    } = req.body;
    
    systemConfig.autoReply = autoReply !== undefined ? autoReply : systemConfig.autoReply;
    systemConfig.geminiModel = geminiModel || systemConfig.geminiModel;
    systemConfig.basePrompt = basePrompt || systemConfig.basePrompt;
    systemConfig.whitelist = whitelist || systemConfig.whitelist;
    systemConfig.blacklist = blacklist || systemConfig.blacklist;
    systemConfig.restrictToWhitelist = restrictToWhitelist !== undefined ? restrictToWhitelist : systemConfig.restrictToWhitelist;
    
    systemConfig.llmProvider = llmProvider || systemConfig.llmProvider || 'gemini';
    systemConfig.ollamaUrl = ollamaUrl || systemConfig.ollamaUrl || 'http://localhost:11434';
    systemConfig.ollamaModel = ollamaModel || systemConfig.ollamaModel || 'llama3';
    
    saveConfig();

    const activeModel = systemConfig.llmProvider === 'ollama' ? systemConfig.ollamaModel : systemConfig.geminiModel;
    const currentKey = apiKey || process.env.GEMINI_API_KEY;

    if (apiKey) {
        process.env.GEMINI_API_KEY = apiKey;
        saveEnvKey(apiKey);
    }

    geminiService.initialize(
        currentKey,
        activeModel,
        systemConfig.basePrompt,
        systemConfig.llmProvider,
        systemConfig.ollamaUrl
    );

    broadcastState();
    res.json({ success: true, config: systemConfig });
});

// Clear logs
app.post('/api/clear-logs', (req, res) => {
    db.run(`DELETE FROM chat_logs`, (err) => {
        if (err) {
            res.status(500).json({ error: "Failed to clear logs" });
        } else {
            broadcast({ type: 'LOGS_CLEARED' });
            res.json({ success: true });
        }
    });
});

// Test chat (Simulator)
app.post('/api/test-chat', async (req, res) => {
    const { message } = req.body;
    
    if (systemConfig.llmProvider === 'gemini' && !geminiService.genAI) {
        return res.status(400).json({ error: "Gemini is not configured. Please supply a valid API key." });
    }

    try {
        const reply = await geminiService.generateReply("SIMULATOR_USER", message);
        res.json({ success: true, reply: reply });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Logout / Unlink WhatsApp Account
app.post('/api/logout', async (req, res) => {
    try {
        console.log("Unlinking WhatsApp account...");
        clientState = 'DISCONNECTED';
        broadcastState();

        if (client) {
            try {
                await client.logout();
            } catch (e) {
                console.warn("client.logout() error (safe to ignore):", e.message);
            }
            try {
                await client.destroy();
            } catch (e) {
                console.warn("client.destroy() error:", e.message);
            }
            client = null;
        }

        // Wipe the local auth session so QR is shown fresh
        const authPath = path.join(userDataPath, '.wwebjs_auth');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log("Cleared .wwebjs_auth session data.");
        }

        // Clear conversation memory
        geminiService.threads.clear();

        res.json({ success: true, message: "Account unlinked. Reinitializing..." });

        // Reinitialize after a short pause
        setTimeout(() => {
            initializeWhatsAppClient();
        }, 2000);
    } catch (error) {
        console.error("Logout error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Restart client without wiping session (for UI retry button)
app.post('/api/restart-client', async (req, res) => {
    try {
        console.log("Restarting WhatsApp client (keeping session)...");
        clientState = 'DISCONNECTED';
        broadcastState();

        if (client) {
            try { await client.destroy(); } catch (e) {}
            client = null;
        }

        res.json({ success: true, message: "Restarting..." });

        setTimeout(() => {
            initializeWhatsAppClient();
        }, 1500);
    } catch (error) {
        console.error("Restart error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Start application
initializeWhatsAppClient();

if (!process.versions.electron) {
    server.listen(PORT, () => {
        console.log(`Whatisapp web dashboard listening on port http://localhost:${PORT}`);
    });
}

module.exports = server;
