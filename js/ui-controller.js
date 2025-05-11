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

        // Show AI avatar/icon if sender is 'ai'
        const avatarDiv = messageElement.querySelector('.avatar');
        if (avatarDiv) {
            if (sender === 'ai') {
                avatarDiv.style.display = '';
                avatarDiv.innerHTML = '🤖';
                avatarDiv.setAttribute('title', 'AI');
            } else {
                avatarDiv.style.display = 'none';
                avatarDiv.innerHTML = '';
            }
        }

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
            setThinkingIndicator(contentElement);
            return;
        }
        if (sender === 'ai' && window.marked) {
            // Use marked.js to render markdown to HTML for AI replies
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
    }

    /**
     * Creates an empty AI message element placeholder
     * @returns {Element} - The created message element
     */
    function createEmptyAIMessage() {
        const chatWindow = document.getElementById('chat-window');
        const messageElement = Utils.createFromTemplate('message-template');
        messageElement.classList.add('ai-message');
        
        const contentElement = messageElement.querySelector('.chat-app__message-content');
        contentElement.innerHTML = '<span class="thinking-indicator">Thinking...</span>'; // Placeholder
        
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
        const stepRegex = /Step (\d+): ([^\n]+)/g;
        let steps = [];
        let match;
        while ((match = stepRegex.exec(escapedText)) !== null) {
            steps.push(`<li><strong>Step ${match[1]}:</strong> ${escapeHtml(match[2])}</li>`);
        }
        if (steps.length > 0) {
            formattedText = `<ol class="cot-steps">${steps.join('')}</ol>`;
            // Show answer if present after steps
            const answerMatch = escapedText.match(/(Answer:|Conclusion:)([\s\S]*)$/);
            if (answerMatch) {
                formattedText += `<div class="answer-section"><strong>${escapeHtml(answerMatch[1])}</strong><br>${escapeHtml(answerMatch[2].trim()).replace(/\n/g, '<br>')}</div>`;
            }
        } else if ((escapedText.includes('Thinking:') || escapedText.includes('Reasoning:')) && (escapedText.includes('Answer:') || escapedText.includes('Conclusion:'))) {
            // Fallback: highlight CoT reasoning if present
            const thinkingMatch = escapedText.match(/(Thinking:|Reasoning:)(.*?)(?=Answer:|Conclusion:|$)/s);
            const answerMatch = escapedText.match(/(Answer:|Conclusion:)(.*?)$/s);
            if (thinkingMatch && answerMatch) {
                const thinkingContent = escapeHtml(thinkingMatch[2].trim());
                const answerContent = escapeHtml(answerMatch[2].trim());
                formattedText = `<div class="thinking-section"><strong>${escapeHtml(thinkingMatch[1])}</strong><br>${thinkingContent.replace(/\n/g, '<br>')}</div>\n<div class="answer-section"><strong>${escapeHtml(answerMatch[1])}</strong><br>${answerContent.replace(/\n/g, '<br>')}</div>`;
            }
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
        const hasReasoning = /Thinking:|Reasoning:/.test(text);
        const hasAnswer = /Answer:|Conclusion:/.test(text);
        if (hasReasoning && hasAnswer && messageElement.classList.contains('ai-message')) {
            const toggleButton = document.createElement('button');
            toggleButton.className = 'toggle-thinking';
            toggleButton.textContent = 'Hide thinking';
            toggleButton.setAttribute('data-expanded', 'true');
            messageElement.querySelector('.chat-app__message-content').parentNode.insertBefore(toggleButton, messageElement.querySelector('.chat-app__message-content').nextSibling);
        }
    }

    /**
     * Adds a search result to the chat window with a 'Read More' button
     * @param {Object} result - {title, url, snippet}
     * @param {Function} onReadMore - Callback when 'Read More' is clicked (optional)
     */
    function addSearchResult(result, onReadMore) {
        if (shownUrls.has(result.url)) return;
        shownUrls.add(result.url);
        const chatWindow = document.getElementById('chat-window');
        const article = document.createElement('article');
        article.className = 'chat-app__message ai-message search-result';
        // Improved card structure
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
        chatWindow.appendChild(article);
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
    };
})(); 