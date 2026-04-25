/**
 * Hardcover Plugin for Thymer
 *
 * Click the 📚 icon in the status bar (or run "Hardcover: Open Library" from
 * the command palette) to open the Hardcover panel, where you can enter your
 * API key and browse your reading library.
 *
 * Features:
 * - Full-panel library view (currently reading, want to read, recently read)
 * - Status bar item showing number of books currently being read
 * - Command palette commands to open the panel or manually sync
 * - Auto-sync every 30 minutes once connected
 * - Sidebar widget showing a quick "currently reading" overview
 *
 * Note on CORS: this plugin calls the Hardcover GraphQL API directly from
 * the browser using fetch(). If you see a network/CORS error on first sync,
 * Hardcover's API may need to allow Thymer's origin — a proxy would be
 * needed in that case.
 */

class Plugin extends AppPlugin {

    onLoad() {
        this.STORAGE_KEY = 'thymer_hardcover_apikey';
        this.books       = null;
        this.syncing     = false;
        this.widgetRefresh = null;

        this.ui.injectCSS(this._css());

        // Register the custom panel type — this is our main UI surface.
        // Thymer calls the callback whenever a panel navigates to this type.
        this.ui.registerCustomPanelType('hardcover', (panel) => {
            this._renderPanel(panel);
        });

        // Status bar: always visible, click to open the panel.
        this.statusBarItem = this.ui.addStatusBarItem({
            label: '📚',
            icon:  'book',
            tooltip: 'Hardcover — click to open',
            onClick: () => this._openPanel(),
        });

        // Command palette
        this.ui.addCommandPaletteCommand({
            label: 'Hardcover: Open Library',
            icon: 'book',
            onSelected: () => this._openPanel(),
        });
        this.ui.addCommandPaletteCommand({
            label: 'Hardcover: Sync Library',
            icon: 'refresh',
            onSelected: () => this._syncAndRefresh(),
        });

        // Sidebar widget — secondary quick-glance surface.
        // Wrapped in try/catch so any render error doesn't kill the whole plugin.
        this.ui.addSidebarWidget((container, { refresh }) => {
            this.widgetRefresh = refresh;
            try { this._renderSidebar(container); } catch (e) {
                container.innerHTML = '<div style="padding:10px 12px;font-size:12px">📚 Hardcover</div>';
            }
            const timer = setInterval(() => this._syncAndRefresh(), 30 * 60 * 1000);
            return () => { clearInterval(timer); this.widgetRefresh = null; };
        });

        // Initial sync if already configured
        if (this._getApiKey()) {
            this._syncLibrary()
                .then(() => { if (this.widgetRefresh) this.widgetRefresh(); })
                .catch(() => {});
        }
    }

    onUnload() {
        if (this.statusBarItem) this.statusBarItem.remove();
    }

    // -------------------------------------------------------------------------
    // API key (stored in localStorage — stays in browser, never sent to Thymer)
    // -------------------------------------------------------------------------

    _getApiKey() {
        return localStorage.getItem(this.STORAGE_KEY) || '';
    }

    _saveApiKey(key) {
        key ? localStorage.setItem(this.STORAGE_KEY, key)
            : localStorage.removeItem(this.STORAGE_KEY);
    }

    // -------------------------------------------------------------------------
    // Panel management
    // -------------------------------------------------------------------------

    async _openPanel() {
        try {
            const panel = await this.ui.createPanel();
            if (panel) {
                this.ui.setActivePanel(panel);
                panel.navigateToCustomType('hardcover');
            }
        } catch (e) {
            this.ui.addToaster({
                title: 'Hardcover',
                message: 'Could not open panel: ' + e.message,
                dismissible: true,
                autoDestroyTime: 4000,
            });
        }
    }

    // Called by Thymer every time a panel navigates to our custom type.
    _renderPanel(panel) {
        const render = () => {
            const el = panel.getElement();
            el.innerHTML = '';
            if (!this._getApiKey()) {
                el.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;';
                this._renderSetup(el, async (key) => {
                    this._saveApiKey(key);
                    try {
                        await this._syncLibrary();
                        if (this.widgetRefresh) this.widgetRefresh();
                        render();
                    } catch (e) {
                        this._saveApiKey('');
                        throw e;
                    }
                });
            } else {
                el.style.cssText = '';
                this._renderLibrary(el, {
                    onSync: async () => { await this._syncAndRefresh(); render(); },
                    onDisconnect: () => {
                        this._saveApiKey('');
                        this.books = null;
                        this._updateStatusBar('ready');
                        if (this.widgetRefresh) this.widgetRefresh();
                        render();
                    },
                });
            }
        };
        render();
    }

    // -------------------------------------------------------------------------
    // Setup form (shown inside the panel when no API key is saved)
    // -------------------------------------------------------------------------

    _renderSetup(container, onConnect) {
        container.innerHTML = `
            <div class="hc-setup">
                <div class="hc-setup-logo">📚</div>
                <h2 class="hc-setup-title">Connect Hardcover</h2>
                <p class="hc-setup-desc">
                    Sync your reading library from Hardcover into Thymer.
                    Paste your API key below to get started.
                </p>
                <div class="hc-field">
                    <label class="hc-label" for="hc-apikey">Hardcover API Key</label>
                    <input
                        id="hc-apikey"
                        type="password"
                        class="hc-input"
                        placeholder="Paste your API key here…"
                        autocomplete="off"
                    />
                </div>
                <button id="hc-connect" class="hc-btn hc-btn-primary hc-btn-wide">Connect</button>
                <div id="hc-err" class="hc-error" style="display:none"></div>
                <a href="https://hardcover.app/account/api" target="_blank" class="hc-setup-link">
                    Get your API key at hardcover.app ↗
                </a>
            </div>`;

        const input = container.querySelector('#hc-apikey');
        const btn   = container.querySelector('#hc-connect');
        const err   = container.querySelector('#hc-err');

        const attempt = async () => {
            let key = (input.value || '').trim();
            if (!key) return;
            if (key.toLowerCase().startsWith('bearer ')) key = key.slice(7).trim();
            btn.disabled    = true;
            btn.textContent = 'Connecting…';
            err.style.display = 'none';
            try {
                await onConnect(key);
            } catch (e) {
                btn.disabled    = false;
                btn.textContent = 'Connect';
                err.textContent = e.message;
                err.style.display = 'block';
            }
        };

        btn.addEventListener('click', attempt);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
        setTimeout(() => input.focus(), 50);
    }

    // -------------------------------------------------------------------------
    // Library view (shown inside the panel once connected)
    // -------------------------------------------------------------------------

    _renderLibrary(container, { onSync, onDisconnect }) {
        const { currentlyReading = [], wantToRead = [], read = [], didNotFinish = [] } = this.books || {};
        const total = currentlyReading.length + wantToRead.length + read.length + didNotFinish.length;

        container.innerHTML = `
            <div class="hc-panel">
                <div class="hc-panel-header">
                    <span class="hc-panel-title">📚 Hardcover Library</span>
                    <div class="hc-panel-actions">
                        <button id="hc-sync" class="hc-btn hc-btn-secondary">↻ Sync</button>
                        <button id="hc-disc" class="hc-btn hc-btn-danger">Disconnect</button>
                    </div>
                </div>
                <div class="hc-panel-body">
                    ${this._sectionHtml('Currently Reading', currentlyReading)}
                    ${this._sectionHtml('Want to Read',      wantToRead.slice(0, 10))}
                    ${this._sectionHtml('Read',              read.slice(0, 10))}
                    ${didNotFinish.length ? this._sectionHtml('Did Not Finish', didNotFinish) : ''}
                    <div class="hc-panel-footer">${total} book${total !== 1 ? 's' : ''} synced</div>
                </div>
            </div>`;

        const syncBtn = container.querySelector('#hc-sync');
        syncBtn.addEventListener('click', async () => {
            syncBtn.disabled    = true;
            syncBtn.textContent = '↻ Syncing…';
            try { await onSync(); } catch (e) {
                syncBtn.disabled    = false;
                syncBtn.textContent = '↻ Sync';
            }
        });

        container.querySelector('#hc-disc').addEventListener('click', onDisconnect);
    }

    _sectionHtml(title, books) {
        if (!books || books.length === 0) return '';
        return `
            <div class="hc-section">
                <div class="hc-section-title">${this.ui.htmlEscape(title)}</div>
                <div class="hc-grid">${books.map(b => this._cardHtml(b)).join('')}</div>
            </div>`;
    }

    _cardHtml(book) {
        const t = this.ui.htmlEscape(book.title);
        const a = book.authors ? this.ui.htmlEscape(book.authors) : '';
        const u = this.ui.htmlEscape(book.url);
        const c = book.cover  ? this.ui.htmlEscape(book.cover)  : '';
        const s = book.rating != null
            ? '★'.repeat(Math.round(book.rating)) + '☆'.repeat(5 - Math.round(book.rating))
            : '';
        return `
            <a class="hc-card" href="${u}" target="_blank" title="${t}">
                <div class="hc-cover">
                    ${c ? `<img src="${c}" alt="" loading="lazy">` : '<div class="hc-cover-blank">📖</div>'}
                </div>
                <div class="hc-card-body">
                    <div class="hc-card-title">${t}</div>
                    ${a ? `<div class="hc-card-author">${a}</div>` : ''}
                    ${s ? `<div class="hc-card-stars">${s}</div>`  : ''}
                </div>
            </a>`;
    }

    // -------------------------------------------------------------------------
    // Sidebar widget (quick overview; bonus on top of the panel)
    // -------------------------------------------------------------------------

    _renderSidebar(container) {
        if (!this._getApiKey()) {
            container.innerHTML = `
                <div style="padding:10px 12px;font-size:12px;color:var(--side-fg-color,#555)">
                    <strong>📚 Hardcover</strong><br>
                    <span style="font-size:11px;color:var(--text-muted,#888)">
                        Click 📚 in the status bar to connect
                    </span>
                </div>`;
            return;
        }
        if (!this.books) {
            container.innerHTML = `
                <div style="padding:10px 12px;font-size:12px;color:var(--text-muted,#888)">
                    📚 Loading…
                </div>`;
            return;
        }
        const books = [...(this.books.currentlyReading || []), ...(this.books.wantToRead || []).slice(0, 3)];
        container.innerHTML = `
            <div style="padding:8px 10px;font-size:12px">
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted,#999);margin-bottom:6px">
                    📚 Reading
                </div>
                ${books.length === 0
                    ? '<div style="color:var(--text-muted,#888)">Nothing in progress</div>'
                    : books.map(b => `
                        <a href="${this.ui.htmlEscape(b.url)}" target="_blank"
                           style="display:flex;gap:8px;align-items:center;padding:4px 2px;text-decoration:none;color:inherit;border-radius:4px">
                            ${b.cover
                                ? `<img src="${this.ui.htmlEscape(b.cover)}" style="width:24px;height:34px;object-fit:cover;border-radius:2px;flex-shrink:0" alt="">`
                                : '📖'}
                            <div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">
                                ${this.ui.htmlEscape(b.title)}
                            </div>
                        </a>`).join('')
                }
            </div>`;
    }

    // -------------------------------------------------------------------------
    // Hardcover GraphQL API
    // -------------------------------------------------------------------------

    async _graphql(query, variables = {}) {
        let key = this._getApiKey();
        if (!key) throw new Error('No API key — click 📚 in the status bar to connect Hardcover.');
        if (key.toLowerCase().startsWith('bearer ')) key = key.slice(7).trim();

        const res = await fetch('https://api.hardcover.app/v1/graphql', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + key,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({ query, variables }),
        });

        if (res.status === 401 || res.status === 403) {
            throw new Error('Invalid API key — please check your Hardcover API key.');
        }
        if (!res.ok) throw new Error('Hardcover API error (' + res.status + ')');

        const json = await res.json();
        if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
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
        } catch (e) {
            this._updateStatusBar('error');
            throw e;
        } finally {
            this.syncing = false;
        }
    }

    _processBooks(userBooks) {
        const g = { currentlyReading: [], wantToRead: [], read: [], didNotFinish: [] };
        for (const ub of userBooks) {
            const b = {
                id:      ub.book_id,
                title:   ub.book && ub.book.title  ? ub.book.title  : 'Unknown',
                cover:   ub.book && ub.book.cached_image ? ub.book.cached_image.url || null : null,
                authors: this._extractAuthors(ub.book && ub.book.cached_contributors),
                rating:  ub.rating,
                url:     'https://hardcover.app/books/' + (ub.book && ub.book.slug ? ub.book.slug : ''),
            };
            switch (ub.status_id) {
                case 1: g.wantToRead.push(b);       break;
                case 2: g.currentlyReading.push(b); break;
                case 3: g.read.push(b);             break;
                case 5: g.didNotFinish.push(b);     break;
            }
        }
        return g;
    }

    /**
     * Hardcover cached_contributors shape:
     *   [{ contribution: string|null, author: { name: string } }]
     * Authors have a null / empty / "Author" contribution.
     * Edge case: single contributor whose contribution equals their own name.
     */
    _extractAuthors(contributors) {
        if (!Array.isArray(contributors) || contributors.length === 0) return '';
        const singleNameAsRole =
            contributors.length === 1 &&
            contributors[0].contribution === (contributors[0].author && contributors[0].author.name);
        return contributors
            .filter(c => singleNameAsRole || !c.contribution || c.contribution === '' || c.contribution === 'Author')
            .map(c => c.author && c.author.name)
            .filter(Boolean)
            .slice(0, 3)
            .join(', ');
    }

    // -------------------------------------------------------------------------
    // Status bar state
    // -------------------------------------------------------------------------

    _updateStatusBar(state) {
        if (!this.statusBarItem) return;
        if (state === 'syncing') {
            this.statusBarItem.setLabel('📚 …');
            this.statusBarItem.setTooltip('Syncing Hardcover…');
        } else if (state === 'error') {
            this.statusBarItem.setLabel('📚 !');
            this.statusBarItem.setTooltip('Hardcover sync error — click to retry');
        } else {
            const n = this.books && this.books.currentlyReading ? this.books.currentlyReading.length : 0;
            this.statusBarItem.setLabel(n > 0 ? '📚 ' + n : '📚');
            this.statusBarItem.setTooltip(
                'Hardcover' + (n > 0 ? ' — ' + n + ' reading' : '') + ' — click to open'
            );
        }
    }

    async _syncAndRefresh() {
        try {
            await this._syncLibrary();
        } catch (e) {
            this.ui.addToaster({
                title: 'Hardcover sync failed',
                message: e.message,
                dismissible: true,
                autoDestroyTime: 6000,
            });
        }
        if (this.widgetRefresh) this.widgetRefresh();
    }

    // -------------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------------

    _css() {
        return [
            /* Panel shell */
            '.hc-panel{height:100%;display:flex;flex-direction:column;font-family:var(--font-family,sans-serif);font-size:13px;color:var(--fg-default,#333)}',
            '.hc-panel-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border-default,#e0e0e0);flex-shrink:0}',
            '.hc-panel-title{font-size:16px;font-weight:600}',
            '.hc-panel-actions{display:flex;gap:8px}',
            '.hc-panel-body{flex:1;overflow-y:auto;padding:20px}',
            '.hc-panel-footer{font-size:12px;color:var(--text-muted,#888);padding-top:16px}',

            /* Buttons */
            '.hc-btn{padding:6px 14px;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .15s}',
            '.hc-btn:disabled{opacity:.55;cursor:not-allowed}',
            '.hc-btn-primary{background:var(--enum-blue-bg,#4a90e2);color:var(--enum-blue-fg,#fff)}',
            '.hc-btn-primary:hover:not(:disabled){opacity:.85}',
            '.hc-btn-secondary{background:var(--bg-secondary,#f0f0f0);color:var(--fg-default,#333)}',
            '.hc-btn-secondary:hover:not(:disabled){opacity:.8}',
            '.hc-btn-danger{background:var(--enum-red-bg,#fee);color:var(--enum-red-fg,#c00)}',
            '.hc-btn-danger:hover:not(:disabled){opacity:.8}',
            '.hc-btn-wide{width:100%;padding:10px;font-size:14px}',

            /* Setup */
            '.hc-setup{display:flex;flex-direction:column;align-items:center;gap:16px;max-width:420px;width:100%;padding:40px 24px;text-align:center}',
            '.hc-setup-logo{font-size:52px;line-height:1}',
            '.hc-setup-title{font-size:22px;font-weight:700;margin:0}',
            '.hc-setup-desc{font-size:14px;color:var(--text-muted,#666);line-height:1.6;margin:0}',
            '.hc-field{width:100%;text-align:left}',
            '.hc-label{font-size:12px;font-weight:600;display:block;margin-bottom:6px}',
            '.hc-input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--border-default,#ddd);border-radius:7px;font-size:14px;background:var(--bg-default,#fff);color:var(--fg-default,#333);outline:none}',
            '.hc-input:focus{border-color:var(--enum-blue-border,#4a90e2);box-shadow:0 0 0 2px rgba(74,144,226,.15)}',
            '.hc-error{color:var(--enum-red-fg,#c00);font-size:13px;text-align:center}',
            '.hc-setup-link{font-size:13px;color:var(--link-color,#4a90e2);text-decoration:none}',
            '.hc-setup-link:hover{text-decoration:underline}',

            /* Book sections */
            '.hc-section{margin-bottom:24px}',
            '.hc-section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted,#999);margin-bottom:10px}',
            '.hc-grid{display:flex;flex-wrap:wrap;gap:10px}',
            '.hc-card{display:flex;align-items:flex-start;gap:10px;width:calc(50% - 5px);min-width:200px;padding:10px;border-radius:8px;background:var(--bg-secondary,#f8f8f8);text-decoration:none;color:inherit;transition:background .12s;box-sizing:border-box}',
            '.hc-card:hover{background:var(--bg-hover,#efefef)}',
            '.hc-cover{width:46px;height:64px;flex-shrink:0;border-radius:4px;overflow:hidden;background:var(--bg-default,#e8e8e8);display:flex;align-items:center;justify-content:center}',
            '.hc-cover img{width:100%;height:100%;object-fit:cover}',
            '.hc-cover-blank{font-size:24px}',
            '.hc-card-body{flex:1;min-width:0}',
            '.hc-card-title{font-size:13px;font-weight:600;line-height:1.3;margin-bottom:3px}',
            '.hc-card-author{font-size:12px;color:var(--text-muted,#888)}',
            '.hc-card-stars{font-size:11px;color:var(--enum-yellow-fg,#f5a623);margin-top:4px}',
        ].join('\n');
    }
}
