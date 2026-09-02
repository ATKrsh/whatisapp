const { GoogleGenerativeAI } = require("@google/generative-ai");

class GeminiService {
    constructor() {
        this.genAI = null;
        this.modelName = "gemini-1.5-flash";
        this.basePrompt = "";
        this.threads = new Map(); // contactId -> array of history messages
        this.llmProvider = "gemini";
        this.ollamaUrl = "http://localhost:11434";
    }

    initialize(apiKey, modelName, basePrompt, llmProvider = "gemini", ollamaUrl = "http://localhost:11434") {
        this.llmProvider = llmProvider || "gemini";
        this.ollamaUrl = ollamaUrl || "http://localhost:11434";
        this.modelName = modelName || "gemini-1.5-flash";
        this.basePrompt = basePrompt || "";

        if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY_HERE") {
            this.genAI = null;
        } else {
            try {
                this.genAI = new GoogleGenerativeAI(apiKey);
            } catch (error) {
                console.error("Failed to initialize Gemini AI SDK:", error);
                this.genAI = null;
            }
        }
        return true;
    }

    updateConfig(modelName, basePrompt, llmProvider, ollamaUrl) {
        this.modelName = modelName;
        this.basePrompt = basePrompt;
        if (llmProvider !== undefined) this.llmProvider = llmProvider;
        if (ollamaUrl !== undefined) this.ollamaUrl = ollamaUrl;
        console.log(`AI configuration updated. Provider: ${this.llmProvider}, Model: ${modelName}`);
    }

    clearHistory(contactId) {
        if (this.threads.has(contactId)) {
            this.threads.delete(contactId);
            return true;
        }
        return false;
    }

    async generateReply(contactId, messageText) {
        // Get or create history thread
        let history = this.threads.get(contactId) || [];
        
        // Limit history to last 10 messages (5 user, 5 bot) to conserve tokens & keep focus
        while (history.length > 10) {
            history.shift();
        }

        if (this.llmProvider === "ollama") {
            try {
                // Use /api/chat endpoint with message roles - this prevents models from
                // continuing the conversation into long roleplay transcripts.
                const systemInstruction = this.basePrompt || 
                    "You are a real person chatting on WhatsApp. Reply in 1 short sentence only. Be casual and natural. No greetings, no explanations, no quotes.";

                // Build message list from history
                const messages = [
                    { role: "system", content: systemInstruction }
                ];

                for (const h of history) {
                    messages.push({
                        role: h.role === 'model' ? 'assistant' : 'user',
                        content: h.parts[0].text
                    });
                }
                messages.push({ role: "user", content: messageText });

                console.log(`Calling local Ollama Chat API (${this.ollamaUrl}) with model ${this.modelName}...`);
                const response = await fetch(`${this.ollamaUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.modelName,
                        messages: messages,
                        stream: false,
                        options: {
                            temperature: 0.7,
                            num_predict: 80,        // hard cap at 80 tokens (~60 words)
                            stop: ["\n", "Friend:", "User:", "You:", "Human:", "Assistant:"]
                        }
                    })
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Ollama response error: ${response.status} ${response.statusText} - ${errText}`);
                }

                const data = await response.json();
                let replyText = (data.message?.content || data.response || "").trim();
                console.log(`[Ollama Raw Response]: "${replyText}"`);

                // Clean any remaining artifacts
                replyText = this.cleanOllamaResponse(replyText);

                // Store in history
                history.push({ role: 'user', parts: [{ text: messageText }] });
                history.push({ role: 'model', parts: [{ text: replyText }] });
                this.threads.set(contactId, history);

                return replyText;
            } catch (error) {
                console.error(`Ollama API Error for chat ${contactId}:`, error);
                throw error;
            }
        } else {
            // Default to Gemini
            if (!this.genAI) {
                throw new Error("Gemini AI is not initialized. Please configure a valid API key or switch to Ollama.");
            }

            try {
                // Create model instance with system instructions
                const model = this.genAI.getGenerativeModel({ 
                    model: this.modelName,
                    systemInstruction: this.basePrompt
                });

                // Start chat session with history
                const chat = model.startChat({
                    history: history
                });

                // Send message and get response
                const result = await chat.sendMessage(messageText);
                const response = await result.response;
                const replyText = response.text().trim();

                // Store message and response in history
                history.push({ role: 'user', parts: [{ text: messageText }] });
                history.push({ role: 'model', parts: [{ text: replyText }] });
                this.threads.set(contactId, history);

                return replyText;
            } catch (error) {
                console.error(`Gemini API Error for chat ${contactId}:`, error);
                throw error;
            }
        }
    }

    cleanOllamaResponse(text) {
        if (!text) return "";
        
        let cleaned = text.trim();

        // 1. Extract dialogue lines. We search for any lines matching Speaker: Content
        // We can split on any speaker prefix (including start of string or newlines)
        const speakerRegex = /(?:^|\r?\n)\s*(?:user|assistant|model|system|bot|contact|friend|ai|me|you|atk)\s*:\s*/i;
        
        if (speakerRegex.test(cleaned)) {
            // Split by speaker prefix
            const parts = cleaned.split(speakerRegex);
            // The first part might be empty if the string started with a speaker prefix.
            // We want to find the first non-empty block that represents a dialogue turn.
            for (const part of parts) {
                const trimmedPart = part.trim();
                if (trimmedPart) {
                    cleaned = trimmedPart;
                    break;
                }
            }
        } else {
            // If there are no speaker prefixes, but there are multiple lines, take the first line
            const lines = cleaned.split(/\r?\n/);
            cleaned = lines[0].trim();
        }

        // 2. Remove common trailing tone labels or metadata in parentheses/brackets, e.g. (Casual tone), (Cautionary tone), [Friendly tone]
        cleaned = cleaned.replace(/\s*\([^)]*\b(?:tone|mood|style|hint|note|casual|formal|caution|neutral|friendly)\b[^)]*\)\s*$/i, '');
        cleaned = cleaned.replace(/\s*\[[^\]]*\b(?:tone|mood|style|hint|note|casual|formal|caution|neutral|friendly)\b[^\]]*\]\s*$/i, '');
        cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/g, ''); // also generally remove trailing parentheses content if it's brief
        cleaned = cleaned.replace(/\s*\[[^\]]*\]\s*$/g, '');

        // 3. Look for explicit output formatting wrappers where the model lists its thought process first.
        // e.g., 'Replying as the user: "..."' or 'Reply: ...'
        const replyExtractors = [
            /(?:replying\s+as\s+the\s+user|replying\s+as\s+user|sample\s+reply|actual\s+reply|my\s+reply|response|reply|message)\s*:\s*["']?([\s\S]*?)["']?$/i,
            /["']([\s\S]*?)["']\s*\([^)]*\)\s*$/i, // quotes followed by a parenthetical tone at the very end
        ];

        for (const regex of replyExtractors) {
            const match = cleaned.match(regex);
            if (match && match[1] && match[1].trim()) {
                cleaned = match[1].trim();
                break;
            }
        }

        // 3.5 If there are double quotes and a preamble, extract the quoted string
        if (cleaned.includes('"')) {
            const matches = [...cleaned.matchAll(/"([^"]+)"/g)];
            if (matches.length > 0) {
                // Return the last quoted block since models put their final reply in quotes
                const lastQuoted = matches[matches.length - 1][1].trim();
                if (lastQuoted) {
                    cleaned = lastQuoted;
                }
            }
        }

        // 4. Remove leading speaker labels from the start of the output
        cleaned = cleaned.replace(/^(?:user|assistant|model|system|bot|contact|friend|ai|me|you|atk)\s*:\s*/i, '');

        // 5. Remove leading and trailing double or single quotes
        cleaned = cleaned.replace(/^["']|["']$/g, '');

        return cleaned.trim();
    }
}

module.exports = new GeminiService();

