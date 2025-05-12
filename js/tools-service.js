/**
 * ./js/tools-service.js
 * Tools Service Module - Provides webSearch and readUrl functions for the AI agent.
 */
const ToolsService = (function() {
    'use strict';

    // Use proxy list from Utils
    let proxies = Utils.corsProxies;
    // Ensure proxies is always an array/iterable
    if (!proxies || typeof proxies[Symbol.iterator] !== 'function') {
        console.warn('Proxies is not iterable, falling back to Utils.getCorsProxies()');
        proxies = Utils.getCorsProxies();
    }

    function getFinalUrl(rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.pathname === '/l/' && parsed.searchParams.has('uddg')) {
          return decodeURIComponent(parsed.searchParams.get('uddg'));
        }
      } catch {}
      return rawUrl;
    }

    /**
     * Performs a search via the specified engine (duckduckgo, google, bing), streams results as found.
     * @param {string} query
     * @param {function} onResult - Callback for each result as it's found
     * @param {string} [engine] - Search engine: 'duckduckgo', 'google', or 'bing'
     * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
     */
    async function webSearch(query, onResult, engine = 'duckduckgo') {
      let searchUrl, parseResults;
      if (engine === 'google') {
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
        parseResults = function(htmlString) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlString, 'text/html');
          const items = doc.querySelectorAll('div.g');
          const results = [];
          items.forEach(item => {
            const anchor = item.querySelector('a');
            const titleElem = item.querySelector('h3');
            if (!anchor || !titleElem) return;
            const href = anchor.href;
            const title = titleElem.textContent.trim();
            const snippetElem = item.querySelector('.VwiC3b, .IsZvec');
            const snippet = snippetElem ? snippetElem.textContent.trim() : '';
            results.push({ title, url: href, snippet });
          });
          return results;
        };
      } else if (engine === 'bing') {
        searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
        parseResults = function(htmlString) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlString, 'text/html');
          const items = doc.querySelectorAll('li.b_algo');
          const results = [];
          items.forEach(item => {
            const anchor = item.querySelector('a');
            const titleElem = item.querySelector('h2');
            if (!anchor || !titleElem) return;
            const href = anchor.href;
            const title = titleElem.textContent.trim();
            const snippetElem = item.querySelector('p');
            const snippet = snippetElem ? snippetElem.textContent.trim() : '';
            results.push({ title, url: href, snippet });
          });
          return results;
        };
      } else {
        // Default to DuckDuckGo
        searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        parseResults = function(htmlString) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlString, 'text/html');
          const container = doc.getElementById('links');
          if (!container) return [];
          const items = container.querySelectorAll('div.result');
          const results = [];
          items.forEach(item => {
            const anchor = item.querySelector('a.result__a');
            if (!anchor) return;
            const href = getFinalUrl(anchor.href);
            const title = anchor.textContent.trim();
            const snippetElem = item.querySelector('a.result__snippet, div.result__snippet');
            const snippet = snippetElem ? snippetElem.textContent.trim() : '';
            results.push({ title, url: href, snippet });
          });
          return results;
        };
      }
      let allResults = [];
      for (const proxy of proxies) {
        try {
          const response = await Utils.fetchWithProxyRetry(searchUrl, {}, [proxy]);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const htmlString = await response.text();
          const results = parseResults(htmlString);
          if (!results.length) throw new Error('No results');
          results.forEach(result => { if (onResult) onResult(result); });
          return results;
        } catch (err) {
          if (allResults.length) {
            if (onResult) allResults.forEach(r => onResult(r));
            return allResults;
          }
        }
      }
      throw new Error('All proxies failed.\n\nTip: Set up your own CORS proxy in Settings for reliable web search and instant answers.');
    }

    /**
     * Fetches and returns text content from a URL via proxies.
     * @param {string} url
     * @returns {Promise<string>}
     */
    async function readUrl(url) {
      for (const proxy of proxies) {
        try {
          const response = await Utils.fetchWithProxyRetry(url, {}, [proxy]);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const htmlString = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlString, 'text/html');
          // Remove <script> and <style> elements
          doc.querySelectorAll('script, style').forEach(el => el.remove());
          // Extract text only from p, h1, h2, and h3 tags
          const selectors = ['p', 'h1', 'h2', 'h3'];
          const texts = [];
          selectors.forEach(tag => {
            doc.querySelectorAll(tag).forEach(el => {
              const t = el.textContent.trim();
              if (t) texts.push(t);
            });
          });
          const resultText = texts.join('\n\n').trim();
          return resultText;
        } catch (err) {
          // Continue to next proxy
        }
      }
      throw new Error('All proxies failed');
    }

    /**
     * Fetches Instant Answer from DuckDuckGo API.
     * @param {string} query - The search query.
     * @returns {Promise<Object>} - The JSON response from DuckDuckGo Instant Answer API.
     */
    async function instantAnswer(query) {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&pretty=1`;
      let response;
      try {
        response = await Utils.fetchWithProxyRetry(url, { method: 'GET' });
      } catch (proxyErr) {
        // Fallback to direct fetch
        response = await fetch(url);
      }
      if (!response.ok) {
        const errText = await (response.text().catch(() => ''));
        throw new Error(`Instant Answer API error ${response.status}: ${errText}\n\nTip: Set up your own CORS proxy in Settings for reliable instant answers.`);
      }
      return response.json();
    }

    return { webSearch, readUrl, instantAnswer };
})(); 