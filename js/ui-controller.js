/**
 * ./js/ui-controller.js
 * UI Controller Module - Manages UI elements and interactions
 * Handles chat display, inputs, and visual elements
 */
const UIController = (function() {
    'use strict';

    // Private state
    let sendMessageCallback = null;
    let clearChatCallback = null;
    
    // Deduplication and offset tracking
    const shownUrls = new Set();
    const urlOffsets = new Map();
    
    let summarizeBtn = null;
    
    // Helper to manage search result groups
    let currentSearchGroup = null;
    let searchGroupCount = 0;
    
    /**
     * Initializes the UI controller
     */
    function init() {
        // Show the chat container
        document.getElementById('chat-container').style.display = 'flex';
        
        // Add enter key handler for message input
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        // Keyboard shortcut: Enter to send, Shift+Enter for newline
        messageInput.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (sendMessageCallback) sendMessageCallback();
            }
        });
        // Auto-resize textarea as user types
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 200) + 'px';
            // Enable/disable send button based on input
            if (sendButton) {
                sendButton.disabled = this.value.trim().length === 0;
            }
        });
        // Set initial state of send button
        if (sendButton) {
            sendButton.disabled = messageInput.value.trim().length === 0;
        }
        // Autofocus message input on init
        setTimeout(() => { messageInput.focus(); }, 0);
        
        // Add global event delegation for thinking toggle buttons
        document.addEventListener('click', function(event) {
            if (event.target.classList.contains('toggle-thinking') || 
                event.target.parentElement.classList.contains('toggle-thinking')) {
                const button = event.target.classList.contains('toggle-thinking') ? 
                               event.target : event.target.parentElement;
                const messageElement = button.closest('.chat-app__message');
                
                // Toggle the expanded state
                const isExpanded = button.getAttribute('data-expanded') === 'true';
                button.setAttribute('data-expanded', !isExpanded);
                
                // Toggle visibility of thinking section
                if (messageElement) {
                    messageElement.classList.toggle('thinking-collapsed');
                    button.textContent = isExpanded ? 'Show thinking' : 'Hide thinking';
                }
            }
        });

        // Show empty state on init
        showEmptyState();
        // Add scroll-to-bottom button
        setupScrollToBottomButton();
    }

    // Floating scroll-to-bottom button logic
    function setupScrollToBottomButton() {
        const chatWindow = document.getElementById('chat-window');
        let btn = document.getElementById('scroll-to-bottom-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'scroll-to-bottom-btn';
            btn.className = 'scroll-to-bottom-btn';
            btn.title = 'Scroll to latest message';
            btn.innerHTML = '↓';
            btn.style.display = 'none';
            btn.addEventListener('click', function() {
                chatWindow.scrollTo({ top: chatWindow.scrollHeight, behavior: 'smooth' });
            });
            chatWindow.parentElement.appendChild(btn);
        }
        chatWindow.addEventListener('scroll', function() {
            const atBottom = chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight < 40;
            btn.style.display = atBottom ? 'none' : 'block';
        });
    }

    /**
     * Sets up event handlers for UI elements
     * @param {Function} onSendMessage - Callback for send button
     * @param {Function} onClearChat - Callback for clear chat button
     */
    function setupEventHandlers(onSendMessage, onClearChat) {
        sendMessageCallback = onSendMessage;
        clearChatCallback = onClearChat;
        
        // Send button click handler
        document.getElementById('send-button').addEventListener('click', onSendMessage);
        
        // Clear chat button click handler
        const clearChatButton = document.getElementById('clear-chat-button');
        if (clearChatButton) {
            clearChatButton.addEventListener('click', function() {
                if (confirm('Are you sure you want to clear the chat history?')) {
                    clearChatWindow();
                    if (clearChatCallback) clearChatCallback();
                }
            });
        }
    }

    /**
     * Adds a message to the chat window
     * @param {string} sender - The sender ('user' or 'ai')
     * @param {string} text - The message text
     * @returns {Element} - The created message element
     */
    function addMessage(sender, text) {
        hideEmptyState();
        const chatWindow = document.getElementById('chat-window');
        const messageElement = Utils.createFromTemplate('message-template');
        
        // Set appropriate class based on sender
        messageElement.classList.add(`${sender}-message`);
        // Add fade-in animation
        messageElement.classList.add('fade-in');

        // Group consecutive messages from the same sender
        const lastMsg = Array.from(chatWindow.children).reverse().find(el => el.classList && el.classList.contains('chat-app__message'));
        if (lastMsg && lastMsg.classList.contains(`${sender}-message`)) {
            messageElement.classList.add('message-grouped');
        }
        
        // Set timestamp
        const timestampElement = messageElement.querySelector('.chat-app__timestamp');
        if (timestampElement) {
            const now = new Date();
            const hours = now.getHours().toString().padStart(2, '0');
            const minutes = now.getMinutes().toString().padStart(2, '0');
            timestampElement.textContent = `${hours}:${minutes}`;
            timestampElement.title = now.toLocaleString();
        }
        
        // Format the message text
        updateMessageContent(messageElement, text, sender);
        
        // Add to chat window and scroll into view
        chatWindow.appendChild(messageElement);
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
        
        return messageElement;
    }

    /**
     * Clears all messages from the chat window
     */
    function clearChatWindow() {
        const chatWindow = document.getElementById('chat-window');
        chatWindow.innerHTML = '';
        showEmptyState();
    }

    /**
     * Updates the content of a message element
     * @param {Element} messageElement - The message element to update
     * @param {string} text - The new text content
     * @param {string} sender - The sender ('user' or 'ai')
     */
    function updateMessageContent(messageElement, text, sender) {
        if (!messageElement) return;
        const contentElement = messageElement.querySelector('.chat-app__message-content');
        if (!contentElement) return;
        // Remove existing toggle button if present
        const existingToggle = messageElement.querySelector('.toggle-thinking');
        if (existingToggle) existingToggle.remove();
        if (text === '🤔 Thinking...') {
            // Do not display anything for thinking in the chat window
            return;
        }
        if (sender === 'ai' && window.marked) {
            contentElement.className = 'chat-app__message-content';
            contentElement.innerHTML = marked.parse(text);
        } else {
            setFormattedContent(contentElement, text);
        }
        addToggleButton(messageElement, text);
    }

    /**
     * Safely escapes HTML
     * @param {string} html - The string to escape
     * @returns {string} - Escaped HTML string
     */
    function escapeHtml(html) {
        const div = document.createElement('div');
        div.textContent = html;
        return div.innerHTML;
    }
    
    /**
     * Formats code blocks in message text
     * @param {string} text - The message text
     * @returns {string} - HTML with formatted code blocks
     */
    function formatCodeBlocks(text) {
        let formatted = '';
        let insideCode = false;
        let codeBlockLang = '';
        let currentText = '';
        
        const lines = text.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (line.startsWith('```')) {
                if (!insideCode) {
                    // Start of code block
                    if (currentText) {
                        formatted += `<div>${formatMessageContent(currentText)}</div>`;
                        currentText = '';
                    }
                    
                    insideCode = true;
                    codeBlockLang = line.slice(3).trim();
                    formatted += `<pre><code class="language-${codeBlockLang}">`;
                } else {
                    // End of code block
                    insideCode = false;
                    formatted += '</code></pre>';
                }
            } else if (insideCode) {
                // Inside code block
                formatted += escapeHtml(line) + '\n';
            } else {
                // Regular text
                currentText += (currentText ? '\n' : '') + line;
            }
        }
        
        // Add any remaining text
        if (currentText) {
            formatted += formatMessageContent(currentText);
        }
        
        return formatted;
    }

    /**
     * Gets the user input from the message input field
     * @returns {string} - The user message
     */
    function getUserInput() {
        const messageInput = document.getElementById('message-input');
        return messageInput.value.trim();
    }

    /**
     * Clears the message input field
     */
    function clearUserInput() {
        const messageInput = document.getElementById('message-input');
        messageInput.value = '';
        messageInput.style.height = 'auto'; // Reset height
        focusMessageInput(); // Refocus after clearing
    }

    /**
     * Creates an empty AI message element placeholder
     * @returns {Element} - The created message element
     */
    function createEmptyAIMessage() {
        const chatWindow = document.getElementById('chat-window');
        const messageElement = Utils.createFromTemplate('message-template');
        messageElement.classList.add('ai-message');
        // No placeholder content
        chatWindow.appendChild(messageElement);
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
        return messageElement;
    }

    /**
     * Shows a status message in the status bar (plain text, no icon, no spinner)
     * @param {string} message - The status message
     * @param {string} [type] - Ignored, always plain text
     * @param {Object} [options] - Ignored
     */
    function showStatus(message, type = 'info', options = {}) {
        const bar = document.getElementById('status-bar');
        if (!bar) return;
        // Remove previous close button if any
        const prevClose = bar.querySelector('.status-bar__close');
        if (prevClose) prevClose.remove();
        // Reset ARIA
        bar.removeAttribute('role');
        bar.setAttribute('aria-live', 'polite');
        // Only show plain text
        bar.textContent = message;
        bar.classList.add('chat-app__status-bar--active');
        bar.style.visibility = '';
    }

    function clearStatus() {
        const bar = document.getElementById('status-bar');
        if (bar) {
            bar.textContent = '';
            bar.classList.remove('chat-app__status-bar--active');
            bar.removeAttribute('role');
            bar.setAttribute('aria-live', 'polite');
            bar.style.visibility = '';
        }
    }

    // Spinner for progress feedback (just show plain text)
    function showSpinner(message) {
        showStatus(message);
    }
    function hideSpinner() { clearStatus(); }

    /**
     * Shows an empty state message in the chat window
     */
    function showEmptyState() {
        const chatWindow = document.getElementById('chat-window');
        if (!chatWindow.querySelector('.empty-state')) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.setAttribute('aria-live', 'polite');
            empty.innerHTML = '<div style="font-size:2.5em;">💬</div><div style="margin-top:10px;">Start a conversation with your AI assistant!<br><span style="font-size:0.95em;color:#888;">Ask anything, get instant answers.</span></div>';
            chatWindow.appendChild(empty);
        }
    }
    function hideEmptyState() {
        const chatWindow = document.getElementById('chat-window');
        const empty = chatWindow.querySelector('.empty-state');
        if (empty) empty.remove();
    }

    /**
     * Show error feedback in the status bar (plain text only)
     */
    function showError(message) {
        showStatus(message);
    }

    // Helper: Format message content (code blocks and CoT reasoning)
    function formatMessageContent(text) {
        // Escape HTML first
        let escapedText = escapeHtml(text);
        // Show warning if present
        let warningHtml = '';
        if (escapedText.startsWith('⚠️')) {
            const lines = escapedText.split('<br>');
            warningHtml = `<div class="cot-warning">${lines[0]}</div>`;
            escapedText = lines.slice(1).join('<br>');
        }
        // Format multi-step reasoning (Step 1:, Step 2:, ...)
        let formattedText = escapedText;
        // New: check for structured steps array in processed response
        if (typeof text === 'object' && text.steps && Array.isArray(text.steps) && text.steps.length > 0) {
            // Render steps as ordered list with type and summary, wrapped in a collapsible container
            formattedText = `<div class="cot-reasoning" style="display:block;" title="This section shows the AI's step-by-step reasoning process."><ol class="cot-steps">` + text.steps.map(step =>
                `<li title=\"This is an intermediate step in the AI's reasoning.\"><span class="cot-step-number">Step ${step.number}</span> <span class="cot-step-type">[${step.type}]</span>: ${escapeHtml(step.text)}<br><span class="cot-step-summary"><em>Summary:</em> ${escapeHtml(step.summary)}</span></li>`
            ).join('') + '</ol></div>';
            if (text.answer) {
                formattedText += `<div class="answer-section"><strong>Final Answer:</strong><br>${escapeHtml(text.answer).replace(/\n/g, '<br>')}</div>`;
            }
            return warningHtml + formattedText;
        }
        // Format code blocks
        if (text.includes('```')) {
            formattedText = formatCodeBlocks(text);
        }
        return warningHtml + formattedText;
    }

    // Helper: Set thinking indicator
    function setThinkingIndicator(contentElement) {
        contentElement.className = 'chat-app__message-content thinking-indicator';
        contentElement.innerHTML = '<span class="thinking-dots" aria-label="Thinking">Thinking<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>';
    }

    // Helper: Set formatted content
    function setFormattedContent(contentElement, text) {
        contentElement.className = 'chat-app__message-content';
        contentElement.innerHTML = formatMessageContent(text);
    }

    // Helper: Add toggle button for CoT responses
    function addToggleButton(messageElement, text) {
        // Show toggle if any reasoning/answer block is present
        const hasReasoning = /Thinking:|Reasoning:|cot-reasoning/.test(text);
        const hasAnswer = /Answer:|Conclusion:|Final Answer/.test(text);
        if (hasReasoning && hasAnswer && messageElement.classList.contains('ai-message')) {
            const toggleButton = document.createElement('button');
            toggleButton.className = 'toggle-thinking';
            toggleButton.textContent = 'Show thinking';
            toggleButton.setAttribute('data-expanded', 'false');
            toggleButton.setAttribute('title', "Show or hide the AI's step-by-step reasoning process");
            // Collapse reasoning by default
            messageElement.classList.add('thinking-collapsed');
            // Insert toggle after message content
            const contentElem = messageElement.querySelector('.chat-app__message-content');
            contentElem.parentNode.insertBefore(toggleButton, contentElem.nextSibling);
            // Add info icon with tooltip
            const infoIcon = document.createElement('span');
            infoIcon.className = 'cot-info-icon';
            infoIcon.innerHTML = 'ℹ️';
            infoIcon.setAttribute('tabindex', '0');
            infoIcon.setAttribute('title', "Click 'Show thinking' to see the AI's step-by-step reasoning. This can help you understand how the answer was reached.");
            toggleButton.parentNode.insertBefore(infoIcon, toggleButton.nextSibling);
        }
    }

    /**
     * Adds a search result to the chat window with a 'Show/Hide search results' toggle
     * @param {Object} result - {title, url, snippet}
     * @param {Function} onReadMore - Callback when 'Read More' is clicked (optional)
     */
    function addSearchResult(result, onReadMore) {
        if (shownUrls.has(result.url)) return;
        shownUrls.add(result.url);
        const chatWindow = document.getElementById('chat-window');

        // If no current group or last group is full, create a new group
        if (!currentSearchGroup || currentSearchGroup.dataset.closed === 'true') {
            searchGroupCount++;
            // Create group container
            const groupContainer = document.createElement('div');
            groupContainer.className = 'search-result-group';
            groupContainer.style.margin = '12px 0';
            groupContainer.style.border = '1px solid var(--border-color, #333)';
            groupContainer.style.borderRadius = '8px';
            groupContainer.style.background = 'var(--background-secondary, #181a20)';
            groupContainer.style.overflow = 'hidden';
            groupContainer.style.padding = '0';
            groupContainer.dataset.closed = 'false';

            // Toggle button
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'search-result-toggle-btn';
            toggleBtn.textContent = 'Show search results';
            toggleBtn.setAttribute('aria-expanded', 'false');
            toggleBtn.style.display = 'block';
            toggleBtn.style.width = '100%';
            toggleBtn.style.padding = '8px 0';
            toggleBtn.style.background = 'var(--background-tertiary, #23262f)';
            toggleBtn.style.border = 'none';
            toggleBtn.style.cursor = 'pointer';
            toggleBtn.style.fontWeight = 'bold';
            toggleBtn.style.fontSize = '1em';
            toggleBtn.style.color = 'var(--primary-color, #fff)';
            toggleBtn.addEventListener('click', function() {
                const isClosed = groupContainer.dataset.closed === 'true';
                groupContainer.dataset.closed = isClosed ? 'false' : 'true';
                resultsWrapper.style.display = isClosed ? '' : 'none';
                toggleBtn.textContent = isClosed ? 'Hide search results' : 'Show search results';
                toggleBtn.setAttribute('aria-expanded', isClosed ? 'true' : 'false');
            });

            // Results wrapper (hidden by default)
            const resultsWrapper = document.createElement('div');
            resultsWrapper.className = 'search-results-wrapper';
            resultsWrapper.style.display = 'none';
            groupContainer.appendChild(toggleBtn);
            groupContainer.appendChild(resultsWrapper);
            chatWindow.appendChild(groupContainer);
            currentSearchGroup = groupContainer;
        }

        // Add the search result article to the current group
        const resultsWrapper = currentSearchGroup.querySelector('.search-results-wrapper');
        const article = document.createElement('article');
        article.className = 'chat-app__message ai-message search-result';
        // Card structure
        const card = document.createElement('div');
        card.className = 'search-result-card';
        // Header with icon and link
        const header = document.createElement('div');
        header.className = 'search-result-header';
        header.innerHTML = `<span class="search-result-icon" aria-hidden="true">🔍</span><a href="${result.url}" target="_blank" rel="noopener noreferrer" tabindex="0">${Utils.escapeHtml(result.title)}</a>`;
        card.appendChild(header);
        // URL
        const urlDiv = document.createElement('div');
        urlDiv.className = 'search-result-url';
        urlDiv.innerHTML = `<a href="${result.url}" target="_blank" rel="noopener noreferrer" tabindex="0">${Utils.escapeHtml(result.url)}</a>`;
        card.appendChild(urlDiv);
        // Snippet
        const snippetDiv = document.createElement('div');
        snippetDiv.className = 'search-result-snippet';
        snippetDiv.textContent = result.snippet;
        card.appendChild(snippetDiv);
        // Removed: Read More button
        article.appendChild(card);
        resultsWrapper.appendChild(article);
        article.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    /**
     * Adds a read result to the chat window, with optional 'Read More' button
     * @param {string} url - The URL that was read
     * @param {string} snippet - The snippet of text read from the URL
     * @param {boolean} hasMore - Whether there is more content to read
     */
    function addReadResult(url, snippet, hasMore) {
        const chatWindow = document.getElementById('chat-window');
        const article = document.createElement('article');
        article.className = 'chat-app__message ai-message read-result';
        // Card structure
        const card = document.createElement('div');
        card.className = 'read-result-card';
        // Header with icon and link
        const header = document.createElement('div');
        header.className = 'read-result-header';
        header.innerHTML = `<span class="read-result-icon" aria-hidden="true">📖</span><a href="${url}" target="_blank" rel="noopener noreferrer" tabindex="0">${Utils.escapeHtml(url)}</a>`;
        card.appendChild(header);
        // Snippet
        const snippetDiv = document.createElement('div');
        snippetDiv.className = 'read-result-snippet';
        snippetDiv.textContent = snippet;
        card.appendChild(snippetDiv);
        // Removed: Read More button
        article.appendChild(card);
        chatWindow.appendChild(article);
        article.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    /**
     * Focuses the message input field
     */
    function focusMessageInput() {
        const messageInput = document.getElementById('message-input');
        if (messageInput) messageInput.focus();
    }

    // Public API
    return {
        init,
        setupEventHandlers,
        addMessage,
        clearChatWindow,
        updateMessageContent,
        getUserInput,
        clearUserInput,
        createEmptyAIMessage,
        showStatus,
        clearStatus,
        addSearchResult,
        addReadResult,
        showSpinner,
        hideSpinner,
        /**
         * Adds a chat bubble with raw HTML content (for tool results)
         * @param {string} sender - 'user' or 'ai'
         * @param {string} html - HTML string for the bubble content
         * @returns {Element} - The created message element
         */
        addHtmlMessage(sender, html) {
            const chatWindow = document.getElementById('chat-window');
            const messageElement = Utils.createFromTemplate('message-template');
            messageElement.classList.add(`${sender}-message`);
            const contentElement = messageElement.querySelector('.chat-app__message-content');
            contentElement.innerHTML = html;
            chatWindow.appendChild(messageElement);
            messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
            return messageElement;
        },
        showError,
        showEmptyState,
        hideEmptyState,
        focusMessageInput,
    };
})(); 