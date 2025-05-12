/**
 * ./js/chat-controller.js
 * Chat Controller Module - Manages chat history and message handling
 * Coordinates between UI and API service for sending/receiving messages
 */
const ChatController = (function() {
    'use strict';

    // Private state
    const state = {
        chatHistory: [],
        totalTokens: 0,
        settings: { streaming: false, enableCoT: false, showThinking: true },
        isThinking: false,
        lastThinkingContent: '',
        lastAnswerContent: '',
        readSnippets: [],
        lastToolCall: null,
        lastToolCallCount: 0,
        MAX_TOOL_CALL_REPEAT: 3,
        lastSearchResults: [],
        autoReadInProgress: false,
        toolCallHistory: [],
        highlightedResultIndices: new Set(),
        readCache: new Map(),
        originalUserQuestion: '',
        toolWorkflowActive: true
    };

    // Debug logging helper
    function debugLog(...args) {
        if (state.settings && state.settings.debug) {
            console.log('[AI-DEBUG]', ...args);
        }
    }

    // Add helper to robustly extract JSON tool calls (handles markdown fences)
    function extractToolCall(text) {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (err) {
            console.warn('Tool JSON parse error:', err, 'from', jsonMatch[0]);
            return null;
        }
    }

    const cotPreamble = `**Chain of Thought Instructions:**
1.  **Understand:** Briefly rephrase the core problem or question.
2.  **Deconstruct:** Break the problem down into smaller, logical steps needed to reach the solution.
3.  **Execute & Explain:** Work through each step sequentially. Show your reasoning, calculations, or data analysis for each step clearly.
4.  **Synthesize:** Combine the findings from the previous steps to formulate the final conclusion.
5.  **Final Answer:** State the final answer clearly and concisely, prefixed exactly with "\nFinal Answer:".

**Important:** After each tool call, you must reason with the results before making another tool call. Do NOT output multiple tool calls in a row. If you need to use another tool, first explain what you learned from the previous tool result, then decide if another tool call is needed.

Begin Reasoning Now:
`;

    // Tool handler registry
    const toolHandlers = {
        web_search: async function(args) {
            debugLog('Tool: web_search', args);
            if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
                UIController.addMessage('ai', 'Error: Invalid web_search query.');
                return;
            }
            const engine = args.engine || 'duckduckgo';
            const userQuestion = state.originalUserQuestion || args.query;
            let queriesToTry = [args.query];
            let aiSuggestedQueries = [];
            // Ask AI for 2 alternative queries
            try {
                const selectedModel = SettingsController.getSettings().selectedModel;
                let aiReply = '';
                // Improved prompt with examples and explicit instructions
                const prompt = `Given the user question: "${userQuestion}", suggest 2 alternative web search queries that are:\n- Different in wording, focus, or approach (not just minor rewordings)\n- Likely to retrieve different or complementary information\n- Use synonyms, related topics, or different angles if possible\n\nFor each, reply with the query on a new line. Avoid trivial changes.\n\nExample:\nUser question: \"What are the health benefits of green tea?\"\nGood alternatives:\n- Scientific studies on green tea and health\n- Green tea antioxidants effects on the body\nBad alternatives:\n- What are the health benefits of green tea? (identical)\n- Green tea health benefits (trivial rewording)`;
                if (selectedModel.startsWith('gpt')) {
                    const res = await ApiService.sendOpenAIRequest(selectedModel, [
                        { role: 'system', content: 'You are an assistant that helps improve web search queries.' },
                        { role: 'user', content: prompt }
                    ]);
                    aiReply = res.choices[0].message.content.trim();
                } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                    const session = ApiService.createGeminiSession(selectedModel);
                    const chatHistory = [
                        { role: 'system', content: 'You are an assistant that helps improve web search queries.' },
                        { role: 'user', content: prompt }
                    ];
                    const result = await session.sendMessage(prompt, chatHistory);
                    const candidate = result.candidates[0];
                    if (candidate.content.parts) {
                        aiReply = candidate.content.parts.map(p => p.text).join(' ').trim();
                    } else if (candidate.content.text) {
                        aiReply = candidate.content.text.trim();
                    }
                }
                // Filter out suggestions that are too similar to the original or to each other
                aiSuggestedQueries = aiReply.split('\n').map(q => q.trim()).filter(q => q && !queriesToTry.includes(q));
                // Use Levenshtein distance and length ratio to filter
                const minDistance = 5; // Minimum edit distance to consider as different
                const minLengthRatio = 0.7;
                aiSuggestedQueries = aiSuggestedQueries.filter(q => {
                    const dist = Utils.levenshtein(q.toLowerCase(), args.query.toLowerCase());
                    const lenRatio = Math.min(q.length, args.query.length) / Math.max(q.length, args.query.length);
                    return dist >= minDistance || lenRatio < minLengthRatio;
                });
                // Remove near-duplicates among suggestions
                const uniqueSuggestions = [];
                aiSuggestedQueries.forEach(q => {
                    if (!uniqueSuggestions.some(uq => {
                        const dist = Utils.levenshtein(q.toLowerCase(), uq.toLowerCase());
                        const lenRatio = Math.min(q.length, uq.length) / Math.max(q.length, uq.length);
                        return dist < minDistance && lenRatio >= minLengthRatio;
                    })) {
                        uniqueSuggestions.push(q);
                    }
                });
                aiSuggestedQueries = uniqueSuggestions;
                queriesToTry = queriesToTry.concat(aiSuggestedQueries);
                debugLog('AI suggested alternative queries (filtered):', aiSuggestedQueries);
            } catch (err) {
                debugLog('Error getting alternative queries from AI:', err);
            }
            let allResults = [];
            for (const query of queriesToTry) {
                UIController.showSpinner(`Searching (${engine}) for "${query}"...`);
                UIController.showStatus(`Searching (${engine}) for "${query}"...`);
                let results = [];
                try {
                    const streamed = [];
                    // --- Add timeout here ---
                    const SEARCH_TIMEOUT_MS = 15000; // 15 seconds
                    results = await Promise.race([
                        ToolsService.webSearch(query, (result) => {
                            streamed.push(result);
                            // Pass highlight flag if this index is in highlightedResultIndices
                            const idx = streamed.length - 1;
                            UIController.addSearchResult(result, (url) => {
                                processToolCall({ tool: 'read_url', arguments: { url, start: 0, length: 1122 } });
                            }, state.highlightedResultIndices.has(idx));
                        }, engine),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Search timed out after 15 seconds.')), SEARCH_TIMEOUT_MS))
                    ]);
                    debugLog(`Web search results for query [${query}]:`, results);
                } catch (err) {
                    UIController.hideSpinner();
                    if (err && err.message && (err.message === 'All proxies failed' || err.message.includes('timed out'))) {
                        UIController.showError('Could not fetch page due to network/proxy error or timeout. Please try again later.');
                        // Add retry button
                        UIController.addHtmlMessage('ai', `Web search failed for "${query}": ${err.message} <button class="retry-btn" style="margin-left:10px;">Retry</button>`);
                        setTimeout(() => {
                            const retryBtn = document.querySelector('.retry-btn');
                            if (retryBtn) {
                                retryBtn.onclick = () => {
                                    retryBtn.disabled = true;
                                    processToolCall({ tool: 'web_search', arguments: { query, engine } });
                                };
                            }
                        }, 100);
                    } else {
                        UIController.addMessage('ai', `Web search failed for "${query}": ${err.message}`);
                    }
                    state.chatHistory.push({ role: 'assistant', content: `Web search failed for "${query}": ${err.message}` });
                    continue;
                }
                allResults = allResults.concat(results);
            }
            UIController.hideSpinner();
            UIController.clearStatus();
            if (!allResults.length) {
                UIController.addMessage('ai', `No search results found for "${args.query}" after trying multiple queries.`);
            }
            // Remove duplicate results by URL
            const uniqueResults = [];
            const seenUrls = new Set();
            debugLog({ step: 'deduplication', before: allResults });
            for (const r of allResults) {
                if (!seenUrls.has(r.url)) {
                    uniqueResults.push(r);
                    seenUrls.add(r.url);
                }
            }
            debugLog({ step: 'deduplication', after: uniqueResults });
            const plainTextResults = uniqueResults.map((r, i) => `${i+1}. ${r.title} (${r.url}) - ${r.snippet}`).join('\n');
            state.chatHistory.push({ role: 'assistant', content: `Search results for "${args.query}" (total ${uniqueResults.length}):\n${plainTextResults}` });
            state.lastSearchResults = uniqueResults;
            debugLog({ step: 'suggestResultsToRead', results: uniqueResults });
            // Prompt AI to suggest which results to read
            await suggestResultsToRead(uniqueResults, args.query);
            UIController.hideSearchResultsLoading();
        },
        read_url: async function(args) {
            debugLog('Tool: read_url', args);
            if (!args.url || typeof args.url !== 'string' || !/^https?:\/\//.test(args.url)) {
                UIController.addMessage('ai', 'Error: Invalid read_url argument.');
                return;
            }
            UIController.showSpinner(`Reading content from ${args.url}...`);
            UIController.showStatus(`Reading content from ${args.url}...`);
            try {
                const result = await ToolsService.readUrl(args.url);
                const start = (typeof args.start === 'number' && args.start >= 0) ? args.start : 0;
                const length = (typeof args.length === 'number' && args.length > 0) ? args.length : 1122;
                const snippet = String(result).slice(start, start + length);
                const hasMore = (start + length) < String(result).length;
                UIController.addReadResult(args.url, snippet, hasMore);
                const plainTextSnippet = `Read content from ${args.url}:\n${snippet}${hasMore ? '...' : ''}`;
                state.chatHistory.push({ role: 'assistant', content: plainTextSnippet });
                // Collect snippets for summarization
                state.readSnippets.push(snippet);
                // (Manual summarization removed: summarization now only happens in auto-read workflow)
            } catch (err) {
                UIController.hideSpinner();
                if (err && err.message && err.message === 'All proxies failed') {
                    UIController.showError('Could not fetch page due to network/proxy error. Please try again later.');
                }
                UIController.addMessage('ai', `Read URL failed: ${err.message}`);
                state.chatHistory.push({ role: 'assistant', content: `Read URL failed: ${err.message}` });
            }
            UIController.hideSpinner();
            UIController.clearStatus();
        },
        instant_answer: async function(args) {
            debugLog('Tool: instant_answer', args);
            if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
                UIController.addMessage('ai', 'Error: Invalid instant_answer query.');
                return;
            }
            UIController.showStatus(`Retrieving instant answer for "${args.query}"...`);
            try {
                const result = await ToolsService.instantAnswer(args.query);
                const text = JSON.stringify(result, null, 2);
                UIController.addMessage('ai', text);
                state.chatHistory.push({ role: 'assistant', content: text });
            } catch (err) {
                UIController.clearStatus();
                UIController.addMessage('ai', `Instant answer failed: ${err.message}`);
                state.chatHistory.push({ role: 'assistant', content: `Instant answer failed: ${err.message}` });
            }
            UIController.clearStatus();
        }
    };

    /**
     * Initializes the chat controller
     * @param {Object} initialSettings - Initial settings for the chat
     */
    function init(initialSettings) {
        // Reset and seed chatHistory with system tool instructions
        state.chatHistory = [{
            role: 'system',
            content: `You are an AI assistant with access to three external tools. You MUST use these tools to answer any question that requires up-to-date facts, statistics, or detailed content. Do NOT attempt to answer such questions from your own knowledge. The tools are:

1. web_search(query) → returns a JSON array of search results [{title, url, snippet}, …]
2. read_url(url[, start, length]) → returns the text content of a web page from position 'start' (default 0) up to 'length' characters (default 1122)
3. instant_answer(query) → returns a JSON object from DuckDuckGo's Instant Answer API for quick facts, definitions, and summaries (no proxies needed)

**INSTRUCTIONS:**
- If you need information from the web, you MUST output a tool call as a single JSON object, and NOTHING else. Do NOT include any explanation, markdown, or extra text.
- After receiving a tool result, reason step by step (Chain of Thought) and decide if you need to call another tool. If so, output another tool call JSON. Only provide your final answer after all necessary tool calls are complete.
- If you need to read a web page, use read_url. If the snippet ends with an ellipsis ("..."), always determine if fetching more text will improve your answer. If so, output another read_url tool call with the same url, start at your previous offset, and length set to 5000. Repeat until you have enough content.
- If you do NOT know the answer, or are unsure, ALWAYS call a tool first.
- When calling a tool, output EXACTLY a JSON object and nothing else, in this format:
  {"tool":"web_search","arguments":{"query":"your query"}}
  {"tool":"read_url","arguments":{"url":"https://example.com","start":0,"length":1122}}
  {"tool":"instant_answer","arguments":{"query":"your query"}}
- Do NOT output any other text, markdown, or explanation with the tool call JSON.
- After receiving the tool result, continue reasoning step by step and then provide your answer.

**EXAMPLES:**
Q: What is the latest news about OpenAI?
A: {"tool":"web_search","arguments":{"query":"latest news about OpenAI"}}

Q: Read the content of https://example.com and summarize it.
A: {"tool":"read_url","arguments":{"url":"https://example.com","start":0,"length":1122}}

Q: What is the capital of France?
A: {"tool":"instant_answer","arguments":{"query":"capital of France"}}

If you understand, follow these instructions for every relevant question. Do NOT answer from your own knowledge if a tool call is needed. Wait for the tool result before continuing.`,
        }];
        if (initialSettings) {
            state.settings = { ...state.settings, ...initialSettings };
        }
        
        // Set up event handlers through UI controller
        UIController.setupEventHandlers(sendMessage, clearChat);
    }

    /**
     * Updates the settings
     * @param {Object} newSettings - The new settings
     */
    function updateSettings(newSettings) {
        state.settings = { ...state.settings, ...newSettings };
        console.log('Chat settings updated:', state.settings);
    }

    /**
     * Clears the chat history and resets token count
     */
    function clearChat() {
        state.chatHistory = [];
        state.totalTokens = 0;
        Utils.updateTokenDisplay(0);
    }

    /**
     * Gets the current settings
     * @returns {Object} - The current settings
     */
    function getSettings() {
        return { ...state.settings };
    }

    /**
     * Generates Chain of Thought prompting instructions
     * @param {string} message - The user message
     * @returns {string} - The CoT enhanced message
     */
    function enhanceWithCoT(message) {
        const detailLevel = (state.settings && state.settings.reasoningDetailLevel) || 'standard';
        let detailInstruction = '';
        if (detailLevel === 'brief') {
            detailInstruction = 'Be as concise as possible, only include the most essential steps.';
        } else if (detailLevel === 'detailed') {
            detailInstruction = 'Be very thorough, include all relevant facts, checks, and possible alternatives.';
        } else {
            detailInstruction = 'Provide a clear, step-by-step explanation.';
        }
        return `${message}\n\nPlease answer using step-by-step reasoning. For each step, label it as [Fact], [Assumption], [Action], or [Decision]. After each step, provide a one-line summary of progress. At the end, give a final answer, clearly separated.\n${detailInstruction}\n\nFormat:\nStep 1 [Fact]: ...\nSummary: ...\nStep 2 [Action]: ...\nSummary: ...\n...\nFinal Answer: ...`;
    }

    /**
     * Robustly parses CoT response for multiple steps and malformed formats
     * @param {string} response - The AI response
     * @param {boolean} isPartial - If this is a partial/streamed response
     * @returns {Object} - { steps: [], answer: string, hasStructuredResponse, partial, error }
     */
    function parseCoTResponse(response, isPartial = false) {
        // Flexible regex: Accepts Step N, Reasoning:, Thinking:, etc. (case-insensitive, extra whitespace tolerated)
        const stepRegex = /(?:Step\s*(\d+)[\s:,-]*)?(?:\[(Fact|Assumption|Action|Decision)\])?[:\-\s]*([\s\S]*?)(?:\n+Summary[:\-\s]*([\s\S]*?)(?=\n|$))?/gi;
        const answerRegex = /(?:Final\s*Answer|Answer|Conclusion)[:\-\s]*([\s\S]*)$/i;
        const steps = [];
        let match;
        let lastIndex = 0;
        let foundStep = false;
        // Try to extract steps
        while ((match = stepRegex.exec(response)) !== null) {
            // Only consider if there's meaningful content
            if ((match[1] || match[2] || match[3]) && match[3] && match[3].trim().length > 0) {
                steps.push({
                    number: match[1] ? parseInt(match[1], 10) : steps.length + 1,
                    type: match[2] || 'Step',
                    text: match[3].trim(),
                    summary: match[4] ? match[4].trim() : ''
                });
                foundStep = true;
                lastIndex = stepRegex.lastIndex;
            }
        }
        // Try to extract answer
        let answer = '';
        let answerMatch = response.match(answerRegex);
        if (answerMatch) {
            answer = answerMatch[1].trim();
        } else if (foundStep) {
            // If steps found but no answer, try to find the next non-step text as answer
            const afterSteps = response.slice(lastIndex).trim();
            if (afterSteps.length > 0) answer = afterSteps;
        }
        // Fallback: Try to extract reasoning/answer blocks if above fails
        if (!foundStep && !answer) {
            const fallbackRegex = /(Thinking:|Reasoning:)([\s\S]*?)(?=Thinking:|Reasoning:|Answer:|Conclusion:|$)|(Answer:|Conclusion:)([\s\S]*?)(?=Thinking:|Reasoning:|Answer:|Conclusion:|$)/gi;
            let thinkingSteps = [];
            let fallbackAnswer = '';
            let hasStructuredResponse = false;
            let error = null;
            let m;
            let foundAnswer = false;
            while ((m = fallbackRegex.exec(response)) !== null) {
                if (m[1] === 'Thinking:' || m[1] === 'Reasoning:') {
                    thinkingSteps.push(m[2].trim());
                    hasStructuredResponse = true;
                } else if (m[3] === 'Answer:' || m[3] === 'Conclusion:') {
                    fallbackAnswer = m[4].trim();
                    foundAnswer = true;
                    hasStructuredResponse = true;
                }
            }
            if (!hasStructuredResponse) {
                if (response.trim().length === 0) {
                    error = 'Empty response from AI.';
                } else {
                    fallbackAnswer = response.trim();
                    error = 'AI response did not follow the expected format.';
                }
            } else if (!foundAnswer && thinkingSteps.length > 0) {
                error = 'AI response missing final Answer.';
            }
            state.lastThinkingContent = thinkingSteps.join('\n---\n');
            state.lastAnswerContent = fallbackAnswer;
            return {
                steps: [],
                answer: fallbackAnswer,
                hasStructuredResponse,
                partial: isPartial,
                error,
                stage: isPartial && !foundAnswer ? 'thinking' : undefined
            };
        }
        // If nothing could be parsed, fallback to raw response with warning
        if (!foundStep && !answer) {
            return {
                steps: [],
                answer: response.trim(),
                hasStructuredResponse: false,
                partial: isPartial,
                error: 'AI response could not be parsed. Showing raw output.'
            };
        }
        // Store last reasoning and answer for compatibility
        state.lastThinkingContent = steps.map(s => s.text).join('\n---\n');
        state.lastAnswerContent = answer;
        return {
            steps,
            answer,
            hasStructuredResponse: true,
            partial: isPartial,
            error: null,
            stage: isPartial && !answer ? 'thinking' : undefined
        };
    }

    /**
     * Helper to summarize parsing issues for UI feedback
     * @param {Object} parsed - Output of parseCoTResponse
     * @returns {string|null} - User-friendly error message or null
     */
    function getCoTParsingFeedback(parsed) {
        if (parsed.error) {
            if (parsed.error === 'Empty response from AI.') {
                return '⚠️ AI returned an empty response.';
            } else if (parsed.error === 'AI response did not follow the expected format.') {
                return '⚠️ AI response did not follow the expected "Thinking: ... Answer: ..." format.';
            } else if (parsed.error === 'AI response missing final Answer.') {
                return '⚠️ AI response is missing a final Answer.';
            } else {
                return `⚠️ ${parsed.error}`;
            }
        }
        return null;
    }

    /**
     * Formats the response for display based on settings
     * @param {Object} processed - The processed response with thinkingSteps and answer
     * @returns {string} - The formatted response for display
     */
    function formatResponseForDisplay(processed) {
        // Show parsing feedback if present
        const feedback = getCoTParsingFeedback(processed);
        let output = '';
        if (feedback) {
            output += feedback + '\n';
        }
        if (!state.settings.enableCoT || !processed.hasStructuredResponse) {
            output += processed.answer;
            return output.trim();
        }
        // If showThinking is enabled, show all reasoning steps and answer
        if (state.settings.showThinking) {
            if (processed.partial && processed.stage === 'thinking') {
                // Show all current thinking steps
                if (processed.steps && processed.steps.length > 0) {
                    output += processed.steps.map((step, i) => `Step ${i+1}: ${step.text}`).join('\n---\n');
                } else {
                    output += '🤔 Thinking...';
                }
            } else if (processed.partial) {
                output += processed.steps.map((step, i) => `Step ${i+1}: ${step.text}`).join('\n---\n');
            } else {
                // Show all steps and final answer
                if (processed.steps && processed.steps.length > 0) {
                    output += processed.steps.map((step, i) => `Step ${i+1}: ${step.text}`).join('\n---\n') + '\n\n';
                }
                output += `Answer: ${processed.answer}`;
            }
        } else {
            // Otherwise just show the answer (or thinking indicator if answer isn't ready)
            output += processed.answer || '🤔 Thinking...';
        }
        return output.trim();
    }

    // Helper: Validate user input
    function isValidUserInput(message) {
        return typeof message === 'string' && message.trim().length > 0;
    }

    // Helper: Set UI input state (enabled/disabled)
    function setInputState(enabled) {
        document.getElementById('message-input').disabled = !enabled;
        document.getElementById('send-button').disabled = !enabled;
    }

    // Helper: Prepare message for sending (CoT, etc.)
    function prepareMessage(message) {
        return state.settings.enableCoT ? enhanceWithCoT(message) : message;
    }

    // Refactored sendMessage with retry logic
    async function sendMessage(messageOverride = null, retryCount = 0, maxRetries = 2) {
        const message = messageOverride !== null ? messageOverride : UIController.getUserInput();
        if (!isValidUserInput(message)) return;
        if (retryCount === 0) {
            state.originalUserQuestion = message;
            state.toolWorkflowActive = true;
            UIController.addMessage('user', message);
        }
        UIController.showStatus(retryCount > 0 ? `Retrying... (Attempt ${retryCount + 1})` : 'Sending message...');
        setInputState(false);
        state.lastThinkingContent = '';
        state.lastAnswerContent = '';
        if (retryCount === 0) UIController.clearUserInput();
        const enhancedMessage = prepareMessage(message);
        const currentSettings = SettingsController.getSettings();
        const selectedModel = currentSettings.selectedModel;
        try {
            if (selectedModel.startsWith('gpt')) {
                if (retryCount === 0) state.chatHistory.push({ role: 'user', content: enhancedMessage });
                console.log(`Sent enhanced message to GPT (attempt ${retryCount + 1}):`, enhancedMessage);
                await handleOpenAIMessage(selectedModel, enhancedMessage);
            } else if (selectedModel.startsWith('gemini') || selectedModel.startsWith('gemma')) {
                if (state.chatHistory.length === 0) {
                    state.chatHistory.push({ role: 'user', content: '' });
                }
                await handleGeminiMessage(selectedModel, enhancedMessage);
            }
        } catch (error) {
            console.error(`Error sending message (attempt ${retryCount + 1}):`, error);
            let userMsg = '';
            if (error && error.userMessage) {
                userMsg = error.userMessage;
            } else if (error && error.message && error.message.toLowerCase().includes('timeout')) {
                if (retryCount < maxRetries) {
                    UIController.addMessage('ai', `⏰ Timeout occurred. Retrying... (Attempt ${retryCount + 2} of ${maxRetries + 1})`);
                    await sendMessage(message, retryCount + 1, maxRetries);
                    UIController.clearStatus();
                    setInputState(true);
                    return;
                } else {
                    userMsg = '⏰ The AI took too long to respond after multiple attempts.';
                    UIController.addHtmlMessage('ai', `${userMsg} <button class="retry-btn" style="margin-left:10px;">Retry</button>`);
                    setTimeout(() => {
                        const retryBtn = document.querySelector('.retry-btn');
                        if (retryBtn) {
                            retryBtn.onclick = () => {
                                retryBtn.disabled = true;
                                sendMessage(message, 0, maxRetries);
                            };
                        }
                    }, 100);
                    UIController.clearStatus();
                    setInputState(true);
                    return;
                }
            } else if (error && error.message && (
                error.message.includes('Failed to fetch') ||
                error.message.includes('Service Unavailable') ||
                error.message.includes('503') ||
                error.message.includes('403')
            )) {
                userMsg = 'The Gemini API is currently unavailable or blocked. Please try again later.';
                UIController.showStatus(userMsg);
            } else {
                userMsg = 'Error: ' + (error && error.message ? error.message : error);
            }
            UIController.addMessage('ai', userMsg);
        } finally {
            Utils.updateTokenDisplay(state.totalTokens);
            UIController.clearStatus();
            setInputState(true);
        }
    }

    // 3. Extract shared helpers for streaming/non-streaming response handling
    async function handleStreamingResponse({ model, aiMsgElement, streamFn, onToolCall }) {
        let streamedResponse = '';
        try {
            // Show status bar feedback instead of chat message
            if (state.settings.enableCoT) {
                UIController.showStatus('AI is reasoning step by step...', 'info', { showProgress: true });
            } else {
                UIController.showStatus('AI is working...');
            }
            const fullReply = await streamFn(
                model,
                state.chatHistory,
                (chunk, fullText) => {
                    streamedResponse = fullText;
                    if (state.settings.enableCoT) {
                        const processed = parseCoTResponse(fullText, true);
                        if (state.isThinking && fullText.includes('Answer:')) {
                            state.isThinking = false;
                        }
                        const displayText = formatResponseForDisplay(processed);
                        UIController.updateMessageContent(aiMsgElement, displayText, 'ai');
                    } else {
                        UIController.updateMessageContent(aiMsgElement, fullText, 'ai');
                    }
                }
            );
            const toolCall = extractToolCall(fullReply);
            if (toolCall && toolCall.tool && toolCall.arguments) {
                await onToolCall(toolCall);
                UIController.clearStatus();
                return;
            }
            if (state.settings.enableCoT) {
                const processed = parseCoTResponse(fullReply);
                if (processed.thinking) {
                    console.log('AI Thinking:', processed.thinking);
                }
                const displayText = formatResponseForDisplay(processed);
                UIController.updateMessageContent(aiMsgElement, displayText, 'ai');
                state.chatHistory.push({ role: 'assistant', content: fullReply });
            } else {
                state.chatHistory.push({ role: 'assistant', content: fullReply });
            }
            const tokenCount = await ApiService.getTokenUsage(model, state.chatHistory);
            if (tokenCount) {
                state.totalTokens += tokenCount;
            }
        } catch (err) {
            UIController.updateMessageContent(aiMsgElement, 'Error: ' + err.message, 'ai');
            throw err;
        } finally {
            state.isThinking = false;
            UIController.clearStatus();
        }
    }

    async function handleNonStreamingResponse({ model, requestFn, onToolCall, aiMsgElement }) {
        if (state.settings.enableCoT) {
            UIController.showStatus('AI is reasoning step by step...', 'info', { showProgress: true });
        } else {
            UIController.showStatus('AI is working...');
        }
        // Ensure aiMsgElement is always defined
        if (!aiMsgElement) {
            aiMsgElement = UIController.createEmptyAIMessage();
        }
        try {
            const result = await requestFn(model, state.chatHistory);
            if (result.error) {
                throw new Error(result.error.message);
            }
            if (result.usage && result.usage.total_tokens) {
                state.totalTokens += result.usage.total_tokens;
            }
            const reply = result.choices[0].message.content;
            const toolCall = extractToolCall(reply);
            if (toolCall && toolCall.tool && toolCall.arguments) {
                await onToolCall(toolCall);
                UIController.clearStatus();
                return;
            }
            if (state.settings.enableCoT) {
                const processed = parseCoTResponse(reply);
                if (processed.thinking) {
                    console.log('AI Thinking:', processed.thinking);
                }
                state.chatHistory.push({ role: 'assistant', content: reply });
                const displayText = formatResponseForDisplay(processed);
                UIController.updateMessageContent(aiMsgElement, displayText, 'ai');
            } else {
                state.chatHistory.push({ role: 'assistant', content: reply });
                UIController.updateMessageContent(aiMsgElement, reply, 'ai');
            }
        } catch (err) {
            throw err;
        } finally {
            UIController.clearStatus();
        }
    }

    // Refactored handleOpenAIMessage
    async function handleOpenAIMessage(model, message) {
        if (state.settings.streaming) {
            UIController.showStatus('Streaming response...');
            const aiMsgElement = UIController.createEmptyAIMessage();
            await handleStreamingResponse({ model, aiMsgElement, streamFn: ApiService.streamOpenAIRequest, onToolCall: processToolCall });
        } else {
            await handleNonStreamingResponse({ model, requestFn: ApiService.sendOpenAIRequest, onToolCall: processToolCall });
        }
    }

    // Helper: Handle streaming Gemini response
    async function handleGeminiStreaming(model, message, aiMsgElement) {
        await handleStreamingResponse({ model, aiMsgElement, streamFn: ApiService.streamGeminiRequest, onToolCall: processToolCall });
    }

    // Helper: Handle non-streaming Gemini response
    async function handleGeminiNonStreaming(model, message) {
        try {
            const session = ApiService.createGeminiSession(model);
            const result = await session.sendMessage(message, state.chatHistory);
            if (result.usageMetadata && typeof result.usageMetadata.totalTokenCount === 'number') {
                state.totalTokens += result.usageMetadata.totalTokenCount;
            }
            const candidate = result.candidates[0];
            let textResponse = '';
            if (candidate.content.parts) {
                textResponse = candidate.content.parts.map(p => p.text).join(' ');
            } else if (candidate.content.text) {
                textResponse = candidate.content.text;
            }
            const toolCall = extractToolCall(textResponse);
            if (toolCall && toolCall.tool && toolCall.arguments) {
                await processToolCall(toolCall);
                return;
            }
            const aiMsgElement = UIController.createEmptyAIMessage();
            if (state.settings.enableCoT) {
                const processed = parseCoTResponse(textResponse);
                if (processed.thinking) {
                    console.log('AI Thinking:', processed.thinking);
                }
                state.chatHistory.push({ role: 'assistant', content: textResponse });
                const displayText = formatResponseForDisplay(processed);
                UIController.updateMessageContent(aiMsgElement, displayText, 'ai');
            } else {
                state.chatHistory.push({ role: 'assistant', content: textResponse });
                UIController.updateMessageContent(aiMsgElement, textResponse, 'ai');
            }
        } catch (err) {
            throw err;
        }
    }

    // Refactored handleGeminiMessage
    async function handleGeminiMessage(model, message) {
        state.chatHistory.push({ role: 'user', content: message });
        if (state.settings.streaming) {
            const aiMsgElement = UIController.createEmptyAIMessage();
            await handleGeminiStreaming(model, message, aiMsgElement);
        } else {
            await handleGeminiNonStreaming(model, message);
        }
    }

    // Enhanced processToolCall using registry and validation
    async function processToolCall(call) {
        debugLog('processToolCall', call);
        if (!state.toolWorkflowActive) return;
        const { tool, arguments: args, skipContinue } = call;
        // Tool call loop protection
        const callSignature = JSON.stringify({ tool, args });
        if (state.lastToolCall === callSignature) {
            state.lastToolCallCount++;
        } else {
            state.lastToolCall = callSignature;
            state.lastToolCallCount = 1;
        }
        if (state.lastToolCallCount > state.MAX_TOOL_CALL_REPEAT) {
            UIController.addMessage('ai', `Error: Tool call loop detected. The same tool call has been made more than ${state.MAX_TOOL_CALL_REPEAT} times in a row. Stopping to prevent infinite loop.`);
        }
        // ... (rest of processToolCall logic, if any)
    }

    // Expose public API
    return {
        init,
        updateSettings,
        clearChat,
        getSettings,
        enhanceWithCoT,
        parseCoTResponse,
        getCoTParsingFeedback,
        formatResponseForDisplay,
        isValidUserInput,
        setInputState,
        prepareMessage,
        sendMessage,
        handleOpenAIMessage,
        handleGeminiMessage,
        processToolCall
    };
})();