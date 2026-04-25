/**
 * Hardcover Plugin for Thymer
 *
 * Syncs your Hardcover reading library into a sidebar widget.
 *
 * Features:
 * - Sidebar widget showing Currently Reading, Want to Read, and Recently Read books
 * - Status bar item showing how many books you're currently reading
 * - Command palette command to manually sync
 * - Auto-refreshes every 30 minutes
 *
 * Setup:
 * - Install as a Global Plugin in Thymer
 * - Enter your Hardcover API key in the widget (get it from https://hardcover.app/account/api)
 *
 * Note: This plugin calls the Hardcover GraphQL API directly from the browser using fetch().
 * If you see a CORS error, Hardcover's API may need to whitelist Thymer's origin — in that
 * case a proxy server would be required.
 */

class Plugin extends AppPlugin {

    onLoad() {
        this.STORAGE_KEY = 'thymer_hardcover_apikey';
        this.books = null;
        this.syncing = false;
        this.widgetRefresh = null;

        this.ui.injectCSS(this._css());

        // Status bar item
        this.statusBarItem = this.ui.addStatusBarItem({
            label: '📚',
            icon: 'book',
            tooltip: 'Hardcover — click to sync',
            onClick: () => this._syncAndRefresh(),
        });

        // Command palette
        this.ui.addCommandPaletteCommand({
            label: 'Hardcover: Sync Library',
            icon: 'book',
            onSelected: () => this._syncAndRefresh(),
        });

        // Sidebar widget
        this.ui.addSidebarWidget((container, { refresh }) => {
            this.widgetRefresh = refresh;
            this._renderWidget(container);

            const interval = setInterval(() => this._syncAndRefresh(), 30 * 60 * 1000);

            return () => {
                clearInterval(interval);
                this.widgetRefresh = null;
            };
        });

        // Initial sync if already configured
        if (this._getApiKey()) {
            this._syncLibrary().then(() => {
                if (this.widgetRefresh) this.widgetRefresh();
            }).catch(() => {});
        }
    }

    onUnload() {
        if (this.statusBarItem) this.statusBarItem.remove();
    }

    // -------------------------------------------------------------------------
    // API key storage (kept in localStorage — never sent to Thymer's servers)
    // -------------------------------------------------------------------------

    _getApiKey() {
        return localStorage.getItem(this.STORAGE_KEY) || '';
    }

    _saveApiKey(key) {
        if (key) {
            localStorage.setItem(this.STORAGE_KEY, key);
        } else {
            localStorage.removeItem(this.STORAGE_KEY);
        }
    }

    // -------------------------------------------------------------------------
    // Hardcover GraphQL API
    // -------------------------------------------------------------------------

    async _graphql(query, variables = {}) {
        let apiKey = this._getApiKey();
        if (!apiKey) throw new Error('No API key configured');
        // Strip "Bearer " prefix if the user pasted the full header value
        if (apiKey.toLowerCase().startsWith('bearer ')) apiKey = apiKey.slice(7).trim();

        const res = await fetch('https://api.hardcover.app/v1/graphql', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query, variables }),
        });

        if (res.status === 401 || res.status === 403) {
            throw new Error('Invalid API key — please check your Hardcover API key.');
        }
        if (!res.ok) throw new Error(`Hardcover API error: ${res.status}`);

        const json = await res.json();
        if (json.errors?.length) throw new Error(json.errors[0].message);
        return json.data;
    }

    async _syncLibrary() {
        if (this.syncing) return;
        this.syncing = true;
        this._updateStatusBar('syncing');

        try {
            const data = await this._graphql(`
                query GetHardcoverLibrary {
                    me {
                        user_books(
                            where: { status_id: { _in: [1, 2, 3, 5] } }
                            order_by: [{ status_id: asc }, { updated_at: desc }]
                            limit: 100
                        ) {
                            book_id
                            status_id
                            rating
                            book {
                                title
                                slug
                                cached_image
                                cached_contributors
                            }
                        }
                    }
                }
            `);

            this.books = this._processBooks(data.me[0].user_books);
            this._updateStatusBar('ready');
        } catch (err) {
            this._updateStatusBar('error');
            throw err;
        } finally {
            this.syncing = false;
        }
    }

    _processBooks(userBooks) {
        const groups = {
            currentlyReading: [],
            wantToRead: [],
            read: [],
            didNotFinish: [],
        };

        for (const ub of userBooks) {
            const entry = {
                id: ub.book_id,
                title: ub.book?.title || 'Unknown Title',
                cover: ub.book?.cached_image?.url || null,
                authors: this._extractAuthors(ub.book?.cached_contributors),
                rating: ub.rating,
                url: `https://hardcover.app/books/${ub.book?.slug}`,
            };

            switch (ub.status_id) {
                case 1: groups.wantToRead.push(entry); break;
                case 2: groups.currentlyReading.push(entry); break;
                case 3: groups.read.push(entry); break;
                case 5: groups.didNotFinish.push(entry); break;
            }
        }

        return groups;
    }

    /**
     * Hardcover's cached_contributors is an array of:
     * { contribution: string|null, author: { name: string } }
     * Authors have null/empty/"Author" contribution.
     */
    _extractAuthors(contributors) {
        if (!Array.isArray(contributors) || contributors.length === 0) return '';

        // Edge case: if the single contributor's contribution equals their own name,
        // treat them as author (known Hardcover metadata quirk)
        const singleNameAsRole =
            contributors.length === 1 &&
            contributors[0].contribution === contributors[0].author?.name;

        return contributors
            .filter(c =>
                singleNameAsRole ||
                !c.contribution ||
                c.contribution === '' ||
                c.contribution === 'Author'
            )
            .map(c => c.author?.name)
            .filter(Boolean)
            .slice(0, 3)
            .join(', ');
    }

    // -------------------------------------------------------------------------
    // Status bar
    // -------------------------------------------------------------------------

    _updateStatusBar(state) {
        if (!this.statusBarItem) return;
        if (state === 'syncing') {
            this.statusBarItem.setLabel('📚 …');
            this.statusBarItem.setTooltip('Syncing Hardcover library…');
        } else if (state === 'error') {
            this.statusBarItem.setLabel('📚 !');
            this.statusBarItem.setTooltip('Hardcover sync failed — click to retry');
        } else {
            const n = this.books?.currentlyReading?.length ?? 0;
            this.statusBarItem.setLabel(n > 0 ? `📚 ${n}` : '📚');
            this.statusBarItem.setTooltip(
                n > 0
                    ? `${n} book${n !== 1 ? 's' : ''} currently reading — click to sync`
                    : 'Hardcover — click to sync'
            );
        }
    }

    async _syncAndRefresh() {
        try {
            await this._syncLibrary();
        } catch (err) {
            this.ui.addToaster({
                title: 'Hardcover sync failed',
                message: err.message,
                dismissible: true,
                autoDestroyTime: 6000,
            });
        }
        if (this.widgetRefresh) this.widgetRefresh();
    }

    // -------------------------------------------------------------------------
    // Widget rendering
    // -------------------------------------------------------------------------

    _renderWidget(container) {
        if (!this._getApiKey()) {
            this._renderSetup(container);
        } else if (!this.books) {
            this._renderLoading(container);
        } else {
            this._renderLibrary(container);
        }
    }

    _renderLoading(container) {
        container.innerHTML = `
            <div class="hc-loading">
                <div class="hc-spin">↻</div>
                <div>Loading library…</div>
            </div>`;
    }

    _renderSetup(container) {
        container.innerHTML = `
            <div class="hc-setup">
                <div class="hc-setup-logo">📚</div>
                <div class="hc-setup-title">Hardcover</div>
                <div class="hc-setup-desc">
                    Paste your Hardcover API key to sync your reading library.
                </div>
                <input
                    id="hc-key-input"
                    type="password"
                    class="hc-input"
                    placeholder="Your API key…"
                    autocomplete="off"
                />
                <button id="hc-connect-btn" class="hc-btn hc-btn-primary">Connect</button>
                <div id="hc-setup-error" class="hc-error" style="display:none"></div>
                <a href="https://hardcover.app/account/api" target="_blank" class="hc-link">
                    Get your API key ↗
                </a>
            </div>`;

        const input = container.querySelector('#hc-key-input');
        const btn   = container.querySelector('#hc-connect-btn');
        const err   = container.querySelector('#hc-setup-error');

        const connect = async () => {
            let key = input.value.trim();
            if (!key) return;
            if (key.toLowerCase().startsWith('bearer ')) key = key.slice(7).trim();

            btn.disabled = true;
            btn.textContent = 'Connecting…';
            err.style.display = 'none';

            this._saveApiKey(key);

            try {
                await this._syncLibrary();
                if (this.widgetRefresh) this.widgetRefresh();
            } catch (e) {
                this._saveApiKey('');
                btn.disabled = false;
                btn.textContent = 'Connect';
                err.textContent = e.message.includes('Invalid API')
                    ? 'Invalid API key — please check and try again.'
                    : `Connection failed: ${e.message}`;
                err.style.display = 'block';
            }
        };

        btn.addEventListener('click', connect);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
    }

    _renderLibrary(container) {
        const { currentlyReading, wantToRead, read } = this.books;
        const total = currentlyReading.length + wantToRead.length + read.length;

        container.innerHTML = `
            <div class="hc-widget">
                <div class="hc-header">
                    <span class="hc-header-title">📚 Hardcover</span>
                    <button id="hc-sync-btn" class="hc-icon-btn" title="Sync">↻</button>
                </div>
                ${this._renderSection('Currently Reading', currentlyReading)}
                ${this._renderSection('Want to Read',      wantToRead.slice(0, 5))}
                ${this._renderSection('Recently Read',     read.slice(0, 5))}
                <div class="hc-footer">
                    <span class="hc-footer-count">${total} book${total !== 1 ? 's' : ''} synced</span>
                    <button id="hc-disconnect" class="hc-text-btn">Disconnect</button>
                </div>
            </div>`;

        const syncBtn = container.querySelector('#hc-sync-btn');
        syncBtn.addEventListener('click', async () => {
            syncBtn.classList.add('hc-spinning');
            syncBtn.disabled = true;
            await this._syncAndRefresh();
            // widget re-rendered by _syncAndRefresh → no need to restore button state
        });

        container.querySelector('#hc-disconnect').addEventListener('click', () => {
            this._saveApiKey('');
            this.books = null;
            this._updateStatusBar('ready');
            if (this.widgetRefresh) this.widgetRefresh();
        });
    }

    _renderSection(title, books) {
        if (!books || books.length === 0) return '';

        const cards = books.map(book => {
            const safeTitle  = this.ui.htmlEscape(book.title);
            const safeAuthor = book.authors ? this.ui.htmlEscape(book.authors) : '';
            const safeUrl    = this.ui.htmlEscape(book.url);
            const safeCover  = book.cover ? this.ui.htmlEscape(book.cover) : '';
            const stars      = book.rating != null
                ? '★'.repeat(Math.round(book.rating)) + '☆'.repeat(5 - Math.round(book.rating))
                : '';

            return `
                <a class="hc-card" href="${safeUrl}" target="_blank" title="${safeTitle}">
                    <div class="hc-cover">
                        ${safeCover
                            ? `<img src="${safeCover}" alt="" loading="lazy" />`
                            : '<div class="hc-cover-blank">📖</div>'
                        }
                    </div>
                    <div class="hc-card-body">
                        <div class="hc-card-title">${safeTitle}</div>
                        ${safeAuthor ? `<div class="hc-card-author">${safeAuthor}</div>` : ''}
                        ${stars      ? `<div class="hc-card-stars">${stars}</div>` : ''}
                    </div>
                </a>`;
        }).join('');

        return `
            <div class="hc-section">
                <div class="hc-section-label">${this.ui.htmlEscape(title)}</div>
                <div class="hc-cards">${cards}</div>
            </div>`;
    }

    // -------------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------------

    _css() {
        return `
            /* ---- shared ---- */
            .hc-widget, .hc-setup, .hc-loading {
                font-family: var(--font-family, -apple-system, BlinkMacSystemFont, sans-serif);
                font-size: 13px;
                color: var(--side-fg-color, #333);
                padding: 12px;
            }

            /* ---- setup screen ---- */
            .hc-setup {
                display: flex; flex-direction: column; align-items: center;
                gap: 10px; text-align: center; padding: 24px 16px;
            }
            .hc-setup-logo  { font-size: 34px; }
            .hc-setup-title { font-size: 15px; font-weight: 600; }
            .hc-setup-desc  { font-size: 12px; color: var(--text-muted, #888); line-height: 1.5; }
            .hc-input {
                width: 100%; box-sizing: border-box;
                padding: 7px 10px;
                border: 1px solid var(--border-default, #ddd);
                border-radius: 6px;
                font-size: 12px;
                background: var(--bg-default, #fff);
                color: var(--fg-default, #333);
                outline: none;
            }
            .hc-input:focus { border-color: var(--enum-blue-border, #4a90e2); }
            .hc-btn {
                width: 100%; padding: 8px 14px;
                border: none; border-radius: 6px;
                font-size: 13px; font-weight: 500;
                cursor: pointer; transition: opacity .15s;
            }
            .hc-btn:disabled { opacity: .55; cursor: not-allowed; }
            .hc-btn-primary {
                background: var(--enum-blue-bg, #4a90e2);
                color: var(--enum-blue-fg, #fff);
            }
            .hc-btn-primary:hover:not(:disabled) { opacity: .85; }
            .hc-error { color: var(--enum-red-fg, #e74c3c); font-size: 12px; }
            .hc-link  { font-size: 11px; color: var(--link-color, #4a90e2); text-decoration: none; }
            .hc-link:hover { text-decoration: underline; }

            /* ---- loading ---- */
            .hc-loading {
                display: flex; flex-direction: column;
                align-items: center; gap: 8px;
                padding: 32px; color: var(--text-muted, #888);
            }
            .hc-spin { font-size: 20px; display: inline-block; animation: hc-rotate 1s linear infinite; }

            /* ---- library header ---- */
            .hc-header {
                display: flex; align-items: center; justify-content: space-between;
                padding-bottom: 10px;
                border-bottom: 1px solid var(--border-default, #eee);
                margin-bottom: 6px;
            }
            .hc-header-title { font-weight: 600; font-size: 13px; }
            .hc-icon-btn {
                background: none; border: none;
                font-size: 16px; line-height: 1;
                cursor: pointer; padding: 2px 5px; border-radius: 4px;
                color: var(--text-muted, #888);
                transition: color .15s, background .15s;
                display: inline-block;
            }
            .hc-icon-btn:hover { color: var(--fg-default, #333); background: var(--bg-hover, #f0f0f0); }
            .hc-spinning { animation: hc-rotate .7s linear infinite; }
            @keyframes hc-rotate { to { transform: rotate(360deg); } }

            /* ---- sections ---- */
            .hc-section { margin: 8px 0; }
            .hc-section-label {
                font-size: 10px; font-weight: 700;
                text-transform: uppercase; letter-spacing: .06em;
                color: var(--text-muted, #999);
                margin-bottom: 5px; padding: 0 2px;
            }
            .hc-cards { display: flex; flex-direction: column; gap: 2px; }

            /* ---- book cards ---- */
            .hc-card {
                display: flex; align-items: center; gap: 9px;
                padding: 5px 7px; border-radius: 6px;
                text-decoration: none; color: inherit;
                transition: background .12s;
            }
            .hc-card:hover { background: var(--bg-hover, rgba(0,0,0,.04)); }
            .hc-cover {
                width: 30px; height: 42px; flex-shrink: 0;
                border-radius: 3px; overflow: hidden;
                background: var(--bg-secondary, #e8e8e8);
                display: flex; align-items: center; justify-content: center;
            }
            .hc-cover img { width: 100%; height: 100%; object-fit: cover; }
            .hc-cover-blank { font-size: 16px; }
            .hc-card-body  { flex: 1; min-width: 0; }
            .hc-card-title {
                font-size: 12px; font-weight: 500;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .hc-card-author {
                font-size: 11px; color: var(--text-muted, #888); margin-top: 1px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .hc-card-stars { font-size: 10px; color: var(--enum-yellow-fg, #f5a623); margin-top: 2px; }

            /* ---- footer ---- */
            .hc-footer {
                display: flex; align-items: center; justify-content: space-between;
                margin-top: 10px; padding-top: 8px;
                border-top: 1px solid var(--border-default, #eee);
            }
            .hc-footer-count { font-size: 11px; color: var(--text-muted, #888); }
            .hc-text-btn {
                background: none; border: none;
                font-size: 11px; color: var(--text-muted, #999);
                cursor: pointer; padding: 0; text-decoration: underline;
            }
            .hc-text-btn:hover { color: var(--enum-red-fg, #e74c3c); }
        `;
    }
}
