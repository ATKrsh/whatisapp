// Whatisapp Dashboard Frontend controller

document.addEventListener('DOMContentLoaded', () => {
    // --- State & Telemetry ---
    const stats = {
        totalReplied: 0,
        totalIgnored: 0,
        activeThreads: new Set()
    };

    // --- DOM Elements ---
    const el = {
        connectionStatusDot: document.getElementById('connection-status-dot'),
        connectionStatusText: document.getElementById('connection-status-text'),
        geminiStatusDot: document.getElementById('gemini-status-dot'),
        geminiStatusText: document.getElementById('gemini-status-text'),
        clientStateBadge: document.getElementById('client-state-badge'),
        
        // Connectivity Containers
        qrContainer: document.getElementById('qr-container'),
        connectedContainer: document.getElementById('connected-container'),
        syncingContainer: document.getElementById('syncing-container'),
        qrCanvas: document.getElementById('qr-canvas'),
        connectedAccountText: document.getElementById('connected-account-text'),
        btnUnlinkAccount: document.getElementById('btn-unlink-account'),
        
        // Logs
        consoleLogsOutput: document.getElementById('console-logs-output'),
        btnClearLogs: document.getElementById('btn-clear-logs'),
        
        // Analytics
        statTotalReplied: document.getElementById('stat-total-replied'),
        statTotalIgnored: document.getElementById('stat-total-ignored'),
        statActiveThreads: document.getElementById('stat-active-threads'),
        
        // Configuration
        formConfig: document.getElementById('form-config'),
        selectProvider: document.getElementById('select-provider'),
        geminiSettings: document.getElementById('gemini-settings'),
        ollamaSettings: document.getElementById('ollama-settings'),
        inputApiKey: document.getElementById('input-api-key'),
        selectModel: document.getElementById('select-model'),
        inputOllamaUrl: document.getElementById('input-ollama-url'),
        inputOllamaModel: document.getElementById('input-ollama-model'),
        toggleAutoreply: document.getElementById('toggle-autoreply'),
        textareaPrompt: document.getElementById('textarea-prompt'),
        inputBlacklist: document.getElementById('input-blacklist'),
        toggleRestrictWhitelist: document.getElementById('toggle-restrict-whitelist'),
        whitelistInputWrapper: document.getElementById('whitelist-input-wrapper'),
        inputWhitelist: document.getElementById('input-whitelist'),
        
        // Simulator
        simulatorChatBox: document.getElementById('simulator-chat-box'),
        inputSimulatorMessage: document.getElementById('input-simulator-message'),
        btnSendSimulator: document.getElementById('btn-send-simulator'),
        
        // Toast
        toastNotification: document.getElementById('toast-notification'),
        toastIcon: document.getElementById('toast-icon'),
        toastMessage: document.getElementById('toast-message'),
        
        // Tabs
        tabBtns: document.querySelectorAll('.tab-btn'),
        tabPanes: document.querySelectorAll('.tab-pane')
    };

    let qrGenerator = null;
    let ws = null;
    let toastTimer = null;

    // --- Initialization Progress Tracker ---
    let initStartTime = Date.now();
    let initTimerInterval = null;
    let initCurrentStep = 1;

    function startInitTimer() {
        initStartTime = Date.now();
        initCurrentStep = 1;
        clearInterval(initTimerInterval);
        setStep(1);
        document.getElementById('init-timeout-warning').classList.add('hidden');

        initTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - initStartTime) / 1000);
            const el = document.getElementById('init-elapsed');
            if (el) el.textContent = `Elapsed: ${elapsed}s`;

            // Auto-advance steps based on time
            if (elapsed >= 5 && initCurrentStep < 2) setStep(2);
            if (elapsed >= 15 && initCurrentStep < 3) setStep(3);

            // Show timeout warning after 60s
            if (elapsed >= 60) {
                document.getElementById('init-timeout-warning').classList.remove('hidden');
            }
        }, 1000);
    }

    function stopInitTimer() {
        clearInterval(initTimerInterval);
        initTimerInterval = null;
    }

    function setStep(stepNum) {
        initCurrentStep = stepNum;
        const titles = [
            '', 
            'Launching Browser Engine',
            'Opening WhatsApp Web',
            'Waiting for QR Code'
        ];
        const descs = [
            '',
            'Starting up Chromium in the background to connect to WhatsApp Web...',
            'Navigating to web.whatsapp.com and checking for saved session...',
            'No saved session found. Generating QR code for you to scan with your phone...'
        ];
        const titleEl = document.getElementById('init-step-title');
        const descEl = document.getElementById('init-step-desc');
        if (titleEl) titleEl.textContent = titles[stepNum];
        if (descEl) descEl.textContent = descs[stepNum];

        for (let i = 1; i <= 3; i++) {
            const stepEl = document.getElementById(`step-${i}`);
            if (!stepEl) continue;
            stepEl.classList.remove('active', 'done');
            if (i < stepNum) stepEl.classList.add('done');
            else if (i === stepNum) stepEl.classList.add('active');
        }
    }

    // Retry button
    document.addEventListener('click', async (e) => {
        if (e.target && e.target.id === 'btn-retry-init') {
            try {
                await fetch('/api/restart-client', { method: 'POST' });
                startInitTimer();
                document.getElementById('init-timeout-warning').classList.add('hidden');
            } catch(err) {
                console.error('Restart failed:', err);
            }
        }
    });

    // --- Toast Notification ---
    function showToast(message, type = 'success', duration = 3000) {
        const icons = { success: '✓', error: '✗', info: 'ℹ' };
        el.toastIcon.textContent = icons[type] || '✓';
        el.toastMessage.textContent = message;
        el.toastNotification.className = `show toast-${type}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            el.toastNotification.className = '';
        }, duration);
    }

    // --- Blink status dot animations ---
    function blinkDot(dotEl, blinkClass, durationMs = 1600) {
        // Remove any existing blink class first to allow re-trigger
        dotEl.classList.remove('blink-red', 'blink-green', 'state-active', 'state-off', 'pulsing');
        void dotEl.offsetWidth; // Force reflow to restart animation
        dotEl.classList.add(blinkClass);
        setTimeout(() => {
            dotEl.classList.remove(blinkClass);
            // Restore original state class
            if (dotEl.id === 'connection-status-dot') {
                dotEl.classList.add('state-active');
            }
        }, durationMs);
    }

    // --- Tab Switching ---
    el.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            el.tabBtns.forEach(b => b.classList.remove('active'));
            el.tabPanes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        });
    });

    // --- Helper functions ---
    function logEvent(message, type = 'system-info') {
        const timeStr = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.innerHTML = `[${timeStr}] ${message}`;
        el.consoleLogsOutput.appendChild(entry);
        el.consoleLogsOutput.scrollTop = el.consoleLogsOutput.scrollHeight;
    }

    function updateStatsUI() {
        el.statTotalReplied.innerText = stats.totalReplied;
        el.statTotalIgnored.innerText = stats.totalIgnored;
        el.statActiveThreads.innerText = stats.activeThreads.size;
    }

    function addTelemetryLog(log) {
        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        
        let type = 'system-info';
        let statusMsg = '';
        
        if (log.status === 'SUCCESS') {
            type = 'system-success';
            statusMsg = `AI Replied: "${log.reply}"`;
            stats.totalReplied++;
            stats.activeThreads.add(log.contact_id);
            // Blink green = reply sent
            blinkDot(el.connectionStatusDot, 'blink-green');
        } else if (log.status === 'ERROR') {
            type = 'system-danger';
            statusMsg = `Error: ${log.error}`;
            stats.totalIgnored++;
        } else if (!log.reply && log.status !== 'AUTO_REPLY_DISABLED') {
            // New incoming message (not yet replied)
            type = 'system-warning';
            statusMsg = `Ignored (State: ${log.status})`;
            stats.totalIgnored++;
            // Blink red = incoming message received
            blinkDot(el.connectionStatusDot, 'blink-red');
        } else {
            type = 'system-warning';
            statusMsg = `Ignored (State: ${log.status})`;
            stats.totalIgnored++;
        }

        const formattedText = `[${timestamp}] <b>${log.contact_name}</b>: "${log.message}" <br>&nbsp;&nbsp;➔ ${statusMsg}`;
        const logNode = document.createElement('div');
        logNode.className = `log-entry ${type}`;
        logNode.innerHTML = formattedText;
        el.consoleLogsOutput.appendChild(logNode);
        el.consoleLogsOutput.scrollTop = el.consoleLogsOutput.scrollHeight;
        
        updateStatsUI();
    }

    // --- Whitelist Toggle Wrapper ---
    function toggleWhitelistWrapper() {
        if (el.toggleRestrictWhitelist.checked) {
            el.whitelistInputWrapper.classList.remove('hidden');
        } else {
            el.whitelistInputWrapper.classList.add('hidden');
        }
    }
    el.toggleRestrictWhitelist.addEventListener('change', toggleWhitelistWrapper);

    // --- Provider Toggle Wrapper ---
    function toggleProviderFields() {
        if (el.selectProvider.value === 'ollama') {
            el.ollamaSettings.classList.remove('hidden');
            el.geminiSettings.classList.add('hidden');
        } else {
            el.geminiSettings.classList.remove('hidden');
            el.ollamaSettings.classList.add('hidden');
        }
    }
    el.selectProvider.addEventListener('change', toggleProviderFields);

    // --- WebSockets Integration ---
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            el.connectionStatusDot.className = 'status-dot state-active';
            el.connectionStatusText.innerText = 'Connected to Dashboard';
            logEvent('Websocket pipeline opened.', 'system-success');
        };

        ws.onclose = () => {
            el.connectionStatusDot.className = 'status-dot pulsing state-off';
            el.connectionStatusText.innerText = 'Server disconnected';
            logEvent('Websocket connection closed. Attempting reconnect...', 'system-warning');
            setTimeout(connectWebSocket, 3000);
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            switch (data.type) {
                case 'STATUS_SYNC':
                    handleStatusSync(data.state);
                    break;
                case 'INITIAL_LOGS':
                    el.consoleLogsOutput.innerHTML = '';
                    stats.totalReplied = 0;
                    stats.totalIgnored = 0;
                    stats.activeThreads.clear();
                    data.logs.forEach(log => addTelemetryLog(log));
                    logEvent('Loaded latest transaction history logs.', 'system-info');
                    break;
                case 'NEW_LOG':
                    addTelemetryLog(data.log);
                    // Flash incoming message (NEW_LOG without reply = incoming)
                    if (!data.log.reply && data.log.status !== 'SUCCESS') {
                        blinkDot(el.connectionStatusDot, 'blink-red');
                    } else if (data.log.status === 'SUCCESS') {
                        blinkDot(el.connectionStatusDot, 'blink-green');
                    }
                    break;
                case 'LOGS_CLEARED':
                    el.consoleLogsOutput.innerHTML = '';
                    stats.totalReplied = 0;
                    stats.totalIgnored = 0;
                    stats.activeThreads.clear();
                    updateStatsUI();
                    logEvent('Database log entries cleared.', 'system-warning');
                    break;
            }
        };
    }

    function handleStatusSync(state) {
        // Update client status badge
        el.clientStateBadge.innerText = state.clientState;
        
        if (state.clientState === 'CONNECTED') {
            el.clientStateBadge.className = 'badge state-active';
            el.connectedContainer.classList.remove('hidden');
            el.qrContainer.classList.add('hidden');
            el.syncingContainer.classList.add('hidden');
            stopInitTimer();
        } else if (state.clientState === 'SCANNING_QR') {
            el.clientStateBadge.className = 'badge state-scanning';
            el.qrContainer.classList.remove('hidden');
            el.connectedContainer.classList.add('hidden');
            el.syncingContainer.classList.add('hidden');
            stopInitTimer();
            
            // Draw QR Code onto Canvas
            if (state.qrData) {
                if (!qrGenerator) {
                    qrGenerator = new QRious({
                        element: el.qrCanvas,
                        value: state.qrData,
                        size: 260
                    });
                } else {
                    qrGenerator.value = state.qrData;
                }
            }
        } else {
            // Disconnected / Syncing - start or keep timer running
            el.clientStateBadge.className = 'badge state-off';
            el.syncingContainer.classList.remove('hidden');
            el.connectedContainer.classList.add('hidden');
            el.qrContainer.classList.add('hidden');
            if (!initTimerInterval) startInitTimer();
        }

        // Gemini/Ollama AI Badge
        if (state.geminiActive) {
            el.geminiStatusDot.className = 'status-dot state-active';
            const providerName = state.llmProvider === 'ollama' ? 'Ollama' : 'Gemini';
            el.geminiStatusText.innerText = `AI Status: ${providerName} Active`;
        } else {
            el.geminiStatusDot.className = 'status-dot state-off';
            el.geminiStatusText.innerText = 'AI Status: Inactive';
        }

        // Auto-reply checkbox sync
        if (state.autoReply !== undefined) {
            el.toggleAutoreply.checked = state.autoReply;
        }
    }

    // Toggle Auto-reply instantly on change
    el.toggleAutoreply.addEventListener('change', async () => {
        try {
            const res = await fetch('/api/config');
            const currentConfig = await res.json();
            const updatedConfig = {
                ...currentConfig,
                autoReply: el.toggleAutoreply.checked
            };
            const saveRes = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedConfig)
            });
            const data = await saveRes.json();
            if (data.success) {
                const state = data.config.autoReply ? 'ON' : 'OFF';
                logEvent(`Auto-Reply mode toggled to ${state}.`, 'system-action');
                showToast(`Auto-Reply ${state}`, 'info');
            }
        } catch (error) {
            console.error("Error toggling autoReply:", error);
            logEvent('Failed to update Auto-Reply mode.', 'system-danger');
            el.toggleAutoreply.checked = !el.toggleAutoreply.checked;
        }
    });

    // --- Unlink Account Button ---
    if (el.btnUnlinkAccount) {
        el.btnUnlinkAccount.addEventListener('click', async () => {
            if (!confirm('⚠️ Unlink this WhatsApp account?\n\nThe bot will disconnect and you\'ll need to scan a new QR code to reconnect.')) return;

            el.btnUnlinkAccount.disabled = true;
            el.btnUnlinkAccount.textContent = 'Unlinking...';
            
            try {
                const res = await fetch('/api/logout', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    logEvent('WhatsApp account unlinked. Waiting for new QR code...', 'system-warning');
                    showToast('Account unlinked. Scan QR to reconnect.', 'info', 5000);
                } else {
                    showToast(`Unlink failed: ${data.error}`, 'error');
                }
            } catch (err) {
                showToast('Unlink request failed.', 'error');
            } finally {
                el.btnUnlinkAccount.disabled = false;
                el.btnUnlinkAccount.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" style="margin-right:6px"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Unlink Account`;
            }
        });
    }

    // --- Configuration Syncing (REST) ---
    async function loadConfig() {
        try {
            const res = await fetch('/api/config');
            const config = await res.json();
            
            el.toggleAutoreply.checked = config.autoReply;
            el.selectModel.value = config.geminiModel;
            el.textareaPrompt.value = config.basePrompt;
            el.inputBlacklist.value = config.blacklist.join(', ');
            el.toggleRestrictWhitelist.checked = config.restrictToWhitelist;
            el.inputWhitelist.value = config.whitelist.join(', ');
            
            el.selectProvider.value = config.llmProvider || 'gemini';
            el.inputOllamaUrl.value = config.ollamaUrl || 'http://localhost:11434';
            el.inputOllamaModel.value = config.ollamaModel || 'llama3';
            
            toggleWhitelistWrapper();
            toggleProviderFields();
            logEvent('Configuration parameters loaded from server.', 'system-info');
        } catch (error) {
            console.error("Failed to fetch configuration details:", error);
            logEvent('Failed to sync configuration details.', 'system-danger');
        }
    }

    el.formConfig.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const blacklistArray = el.inputBlacklist.value
            .split(',')
            .map(num => num.trim())
            .filter(num => num.length > 0);
            
        const whitelistArray = el.inputWhitelist.value
            .split(',')
            .map(num => num.trim())
            .filter(num => num.length > 0);

        const configPayload = {
            autoReply: el.toggleAutoreply.checked,
            geminiModel: el.selectModel.value,
            basePrompt: el.textareaPrompt.value,
            blacklist: blacklistArray,
            whitelist: whitelistArray,
            restrictToWhitelist: el.toggleRestrictWhitelist.checked,
            llmProvider: el.selectProvider.value,
            ollamaUrl: el.inputOllamaUrl.value.trim(),
            ollamaModel: el.inputOllamaModel.value.trim()
        };

        const key = el.inputApiKey.value.trim();
        if (key.length > 0) {
            configPayload.apiKey = key;
        }

        const submitBtn = e.submitter || e.target.querySelector('[type=submit]');
        const origText = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) { submitBtn.textContent = 'Saving...'; submitBtn.disabled = true; }

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configPayload)
            });
            const data = await res.json();
            
            if (data.success) {
                logEvent('Configuration saved successfully.', 'system-success');
                showToast('Configuration saved!', 'success');
                el.inputApiKey.value = '';
                loadConfig();
            }
        } catch (error) {
            console.error("Error saving config:", error);
            logEvent('Failed to save configuration details.', 'system-danger');
            showToast('Failed to save configuration.', 'error');
        } finally {
            if (submitBtn) { submitBtn.textContent = origText; submitBtn.disabled = false; }
        }
    });

    // Clear logs API
    el.btnClearLogs.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to clear all log entries from the database?')) return;
        try {
            const res = await fetch('/api/clear-logs', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                logEvent('Logs cleared.', 'system-success');
                showToast('Logs cleared.', 'info');
            }
        } catch (error) {
            console.error("Failed to clear logs:", error);
        }
    });

    // --- Chat Simulator Sandbox ---
    async function sendSimulatorMessage() {
        const messageText = el.inputSimulatorMessage.value.trim();
        if (!messageText) return;

        appendChatBubble('user', messageText);
        el.inputSimulatorMessage.value = '';

        // Show typing indicator bubble
        const thinkingBubble = appendChatBubble('bot', '');
        thinkingBubble.innerHTML = '<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
        
        try {
            const res = await fetch('/api/test-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: messageText })
            });
            const data = await res.json();
            
            thinkingBubble.remove();
            
            if (data.success) {
                appendChatBubble('bot', data.reply);
            } else {
                appendChatBubble('system', `Error: ${data.error}`);
            }
        } catch (error) {
            thinkingBubble.remove();
            appendChatBubble('system', `Error: ${error.message}`);
        }
    }

    function appendChatBubble(sender, text) {
        const bubble = document.createElement('div');
        bubble.className = `chat-message ${sender}`;
        bubble.innerText = text;
        el.simulatorChatBox.appendChild(bubble);
        el.simulatorChatBox.scrollTop = el.simulatorChatBox.scrollHeight;
        return bubble;
    }

    el.btnSendSimulator.addEventListener('click', sendSimulatorMessage);
    el.inputSimulatorMessage.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendSimulatorMessage();
    });

    // --- Init ---
    connectWebSocket();
    loadConfig();
    startInitTimer(); // Begin counting immediately so user always sees progress

    // ── Electron Titlebar bindings ──────────────────────────────────
    if (window.electronAPI) {
        document.getElementById('minBtn').addEventListener('click', () => window.electronAPI.minimize());
        document.getElementById('maxBtn').addEventListener('click', () => window.electronAPI.maximize());
        document.getElementById('closeBtn').addEventListener('click', () => window.electronAPI.close());
    } else {
        const tb = document.querySelector('.titlebar');
        if (tb) tb.style.display = 'none';
        document.body.style.paddingTop = '0';
    }
});
