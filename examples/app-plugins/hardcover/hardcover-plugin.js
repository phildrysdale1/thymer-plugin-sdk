/**
 * Hardcover Books — Thymer Collection Plugin
 *
 * Creates one page (record) per book in your Hardcover library.
 * Each record gets: Title, Author, Published Year, Read Date,
 * Synopsis, Genres, Status, and Rating.
 *
 * Setup:
 * 1. Install as a Collection Plugin on a new "Books" collection
 * 2. Click "Sync Hardcover" in the collection toolbar
 * 3. Enter your Hardcover API key and Cloudflare proxy URL
 *
 * The Cloudflare proxy is required because Hardcover's API blocks
 * direct browser requests (CORS). Deploy hardcover-proxy-worker.js
 * as a Cloudflare Worker to get your proxy URL.
 */

class Plugin extends CollectionPlugin {

    onLoad() {
        this.API_KEY_STORAGE   = 'thymer_hardcover_apikey';
        this.PROXY_URL_STORAGE = 'thymer_hardcover_proxyurl';
        this.syncing = false;

        this.ui.injectCSS(this._css());

        // Setup panel — opened when not yet configured
        this.ui.registerCustomPanelType('hardcover-books-setup', (panel) => {
            this._renderSetupPanel(panel);
        });

        // Button in the collection toolbar
        this.addCollectionNavigationButton({
            label: 'Sync Hardcover',
            icon: 'refresh',
            onClick: () => this._onSyncClicked(),
        });
    }

    onUnload() {}

    // -------------------------------------------------------------------------
    // Sync trigger
    // -------------------------------------------------------------------------

    async _onSyncClicked() {
        if (!this._getApiKey() || !this._getProxyUrl()) {
            await this._openSetupPanel();
            return;
        }
        await this._runSync();
    }

    async _openSetupPanel() {
        try {
            const panel = await this.ui.createPanel();
            if (panel) {
                this.ui.setActivePanel(panel);
                panel.navigateToCustomType('hardcover-books-setup');
            }
        } catch (e) {
            this.ui.addToaster({
                title: 'Hardcover',
                message: 'Could not open setup panel: ' + e.message,
                dismissible: true,
                autoDestroyTime: 5000,
            });
        }
    }

    // -------------------------------------------------------------------------
    // Setup panel
    // -------------------------------------------------------------------------

    _renderSetupPanel(panel) {
        const render = () => {
            const el = panel.getElement();
            el.innerHTML = '';
            el.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;';

            if (!this._getApiKey() || !this._getProxyUrl()) {
                this._renderSetupForm(el, async (key, proxyUrl) => {
                    this._saveApiKey(key);
                    this._saveProxyUrl(proxyUrl);
                    try {
                        // Verify the key works before proceeding
                        await this._graphql('query { me { id } }');
                        render();
                        this._runSync();
                    } catch (e) {
                        this._saveApiKey('');
                        this._saveProxyUrl('');
                        throw e;
                    }
                });
            } else {
                el.innerHTML = `
                    <div class="hc-setup">
                        <div class="hc-setup-logo">✅</div>
                        <h2 class="hc-setup-title">Hardcover Connected</h2>
                        <p class="hc-setup-desc">Your library is syncing. Click “Sync Hardcover” in the collection toolbar at any time to refresh.</p>
                        <button id="hc-disc" class="hc-btn hc-btn-danger">Disconnect</button>
                    </div>`;
                el.querySelector('#hc-disc').addEventListener('click', () => {
                    this._saveApiKey('');
                    this._saveProxyUrl('');
                    render();
                });
            }
        };
        render();
    }

    _renderSetupForm(container, onConnect) {
        container.innerHTML = `
            <div class="hc-setup">
                <div class="hc-setup-logo">📚</div>
                <h2 class="hc-setup-title">Connect Hardcover</h2>
                <p class="hc-setup-desc">
                    Sync your Hardcover library into this collection.
                    Each book will get its own page with title, author, genres, and more.
                </p>
                <div class="hc-field">
                    <label class="hc-label" for="hc-apikey">Hardcover API Key</label>
                    <input id="hc-apikey" type="password" class="hc-input"
                           placeholder="Paste your API key…" autocomplete="off" />
                    <div class="hc-field-hint">
                        <a href="https://hardcover.app/account/api" target="_blank" class="hc-link">Get your API key ↗</a>
                    </div>
                </div>
                <div class="hc-field">
                    <label class="hc-label" for="hc-proxy">Cloudflare Worker Proxy URL</label>
                    <input id="hc-proxy" type="url" class="hc-input"
                           placeholder="https://hardcover-proxy.yourname.workers.dev" />
                    <div class="hc-field-hint">
                        Required to bypass browser CORS. Deploy
                        <code>hardcover-proxy-worker.js</code> as a Cloudflare Worker
                        and paste its URL here.
                    </div>
                </div>
                <button id="hc-connect" class="hc-btn hc-btn-primary hc-btn-wide">Connect &amp; Sync</button>
                <div id="hc-err" class="hc-error" style="display:none"></div>
            </div>`;

        const inputKey   = container.querySelector('#hc-apikey');
        const inputProxy = container.querySelector('#hc-proxy');
        const btn        = container.querySelector('#hc-connect');
        const err        = container.querySelector('#hc-err');

        inputKey.value   = this._getApiKey();
        inputProxy.value = this._getProxyUrl();

        const attempt = async () => {
            let key   = (inputKey.value   || '').trim();
            let proxy = (inputProxy.value || '').trim();
            if (!key)   { err.textContent = 'Please enter your API key.';   err.style.display = 'block'; return; }
            if (!proxy) { err.textContent = 'Please enter your proxy URL.'; err.style.display = 'block'; return; }
            if (key.toLowerCase().startsWith('bearer ')) key = key.slice(7).trim();
            btn.disabled    = true;
            btn.textContent = 'Connecting…';
            err.style.display = 'none';
            try {
                await onConnect(key, proxy);
            } catch (e) {
                btn.disabled    = false;
                btn.textContent = 'Connect & Sync';
                err.textContent = e.message;
                err.style.display = 'block';
            }
        };

        btn.addEventListener('click', attempt);
        [inputKey, inputProxy].forEach(i =>
            i.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); })
        );
        setTimeout(() => inputKey.focus(), 50);
    }

    // -------------------------------------------------------------------------
    // Main sync
    // -------------------------------------------------------------------------

    async _runSync() {
        if (this.syncing) {
            this.ui.addToaster({ title: 'Hardcover', message: 'Sync already in progress.', dismissible: true, autoDestroyTime: 3000 });
            return;
        }
        this.syncing = true;

        this.ui.addToaster({
            title: 'Hardcover',
            message: 'Fetching your library…',
            dismissible: true,
            autoDestroyTime: 3000,
        });

        try {
            const books = await this._fetchAllBooks();

            // Index existing records by hardcover_id for O(1) lookup
            const existing = await this.collection.getAllRecords();
            const byHcId = new Map();
            for (const rec of existing) {
                const hcId = rec.number('hardcover_id');
                if (hcId != null) byHcId.set(hcId, rec);
            }

            let created = 0;
            let updated = 0;

            for (const book of books) {
                if (byHcId.has(book.id)) {
                    await this._applyToRecord(byHcId.get(book.id), book);
                    updated++;
                } else {
                    await this._createRecord(book);
                    created++;
                }
            }

            this.ui.addToaster({
                title: 'Hardcover sync complete',
                message: created + ' created, ' + updated + ' updated',
                dismissible: true,
                autoDestroyTime: 5000,
            });
        } catch (e) {
            this.ui.addToaster({
                title: 'Hardcover sync failed',
                message: e.message,
                dismissible: true,
                autoDestroyTime: 10000,
            });
        } finally {
            this.syncing = false;
        }
    }

    // -------------------------------------------------------------------------
    // Record create / update
    // -------------------------------------------------------------------------

    async _createRecord(book) {
        const guid = this.collection.createRecord(book.title);
        if (!guid) return;
        const record = await this.collection.getRecord(guid);
        if (!record) return;
        await this._applyToRecord(record, book);
    }

    async _applyToRecord(record, book) {
        const set = (fieldId, value) => {
            if (value == null || value === '') return;
            const prop = record.prop(fieldId);
            if (!prop) return;
            return value;
        };

        const p = (id) => record.prop(id);

        if (book.author        && p('author'))         p('author').setText(book.author);
        if (book.publishedYear && p('published_year')) p('published_year').setNumber(book.publishedYear);
        if (book.readDate      && p('read_date'))      p('read_date').setText(book.readDate);
        if (book.synopsis      && p('synopsis'))       p('synopsis').setText(book.synopsis);
        if (book.status        && p('status'))         p('status').setChoice(book.status);
        if (book.rating != null && p('rating'))        p('rating').setNumber(book.rating);
        if (p('hardcover_id'))                         p('hardcover_id').setNumber(book.id);

        if (book.genres && book.genres.length > 0 && p('genres')) {
            const genresProp = p('genres');
            genresProp.clear();
            for (const g of book.genres) {
                genresProp.add(g);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Hardcover API
    // -------------------------------------------------------------------------

    async _fetchAllBooks() {
        const data = await this._graphql(`
            query GetHardcoverLibrary {
                me {
                    user_books(
                        where: { status_id: { _in: [1, 2, 3, 5] } }
                        order_by: { updated_at: desc }
                        limit: 500
                    ) {
                        book_id
                        status_id
                        rating
                        book {
                            title
                            release_date
                            description
                            cached_contributors
                            cached_tags
                        }
                        user_book_reads(
                            order_by: { started_at: desc }
                            limit: 1
                        ) {
                            started_at
                            finished_at
                        }
                    }
                }
            }
        `);

        return data.me[0].user_books.map(ub => this._mapBook(ub));
    }

    _mapBook(ub) {
        const book  = ub.book || {};
        const reads = ub.user_book_reads || [];
        const read  = reads[0] || null;

        return {
            id:            ub.book_id,
            title:         book.title || 'Unknown',
            author:        this._extractAuthors(book.cached_contributors),
            publishedYear: this._extractYear(book.release_date),
            readDate:      this._formatReadDate(read),
            synopsis:      book.description ? book.description.replace(/\n+/g, ' ').trim() : null,
            genres:        this._extractGenres(book.cached_tags),
            status:        this._mapStatus(ub.status_id),
            rating:        ub.rating,
        };
    }

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

    _extractYear(releaseDate) {
        if (!releaseDate) return null;
        const y = parseInt(releaseDate.slice(0, 4), 10);
        return isNaN(y) ? null : y;
    }

    _formatReadDate(read) {
        if (!read) return null;
        const dateStr = read.finished_at || read.started_at;
        if (!dateStr) return null;
        // Hardcover dates are YYYY-MM-DD; if day is 01 it often means only month is known
        const parts = dateStr.slice(0, 10).split('-');
        if (parts.length < 2) return parts[0]; // year only
        const year  = parts[0];
        const month = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'][parseInt(parts[1], 10) - 1];
        if (!parts[2] || parts[2] === '01') return month + ' ' + year;
        return parts[2] + ' ' + month + ' ' + year;
    }

    _extractGenres(cachedTags) {
        if (!cachedTags || !Array.isArray(cachedTags.Genre)) return [];
        return cachedTags.Genre
            .slice() // don't mutate
            .sort((a, b) => (b.count || 0) - (a.count || 0))
            .slice(0, 5)
            .map(t => t.tag)
            .filter(Boolean);
    }

    _mapStatus(statusId) {
        switch (statusId) {
            case 1: return 'Want to Read';
            case 2: return 'Currently Reading';
            case 3: return 'Read';
            case 5: return 'Did Not Finish';
            default: return null;
        }
    }

    async _graphql(query, variables = {}) {
        let key     = this._getApiKey();
        const proxy = this._getProxyUrl();
        if (!key)   throw new Error('No API key configured.');
        if (!proxy) throw new Error('No proxy URL configured.');
        if (key.toLowerCase().startsWith('bearer ')) key = key.slice(7).trim();

        const res = await fetch(proxy, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + key,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({ query, variables }),
        });

        if (res.status === 401 || res.status === 403) throw new Error('Invalid API key.');
        if (!res.ok) throw new Error('Request failed (' + res.status + '). Check your proxy URL.');

        const json = await res.json();
        if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
        return json.data;
    }

    // -------------------------------------------------------------------------
    // Storage (localStorage keeps sensitive data out of Thymer's servers)
    // -------------------------------------------------------------------------

    _getApiKey()     { return localStorage.getItem(this.API_KEY_STORAGE)   || ''; }
    _getProxyUrl()   { return localStorage.getItem(this.PROXY_URL_STORAGE) || ''; }
    _saveApiKey(k)   { k ? localStorage.setItem(this.API_KEY_STORAGE,   k) : localStorage.removeItem(this.API_KEY_STORAGE);   }
    _saveProxyUrl(u) { u ? localStorage.setItem(this.PROXY_URL_STORAGE, u) : localStorage.removeItem(this.PROXY_URL_STORAGE); }

    // -------------------------------------------------------------------------
    // CSS
    // -------------------------------------------------------------------------

    _css() {
        return [
            '.hc-setup{display:flex;flex-direction:column;align-items:center;gap:16px;max-width:440px;width:100%;padding:40px 24px;text-align:center;font-family:var(--font-family,sans-serif)}',
            '.hc-setup-logo{font-size:52px;line-height:1}',
            '.hc-setup-title{font-size:22px;font-weight:700;margin:0;color:var(--fg-default,#333)}',
            '.hc-setup-desc{font-size:14px;color:var(--text-muted,#666);line-height:1.6;margin:0}',
            '.hc-field{width:100%;text-align:left}',
            '.hc-label{font-size:12px;font-weight:600;display:block;margin-bottom:5px;color:var(--fg-default,#333)}',
            '.hc-input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--border-default,#ddd);border-radius:7px;font-size:14px;background:var(--bg-default,#fff);color:var(--fg-default,#333);outline:none}',
            '.hc-input:focus{border-color:var(--enum-blue-border,#4a90e2);box-shadow:0 0 0 2px rgba(74,144,226,.15)}',
            '.hc-field-hint{font-size:11px;color:var(--text-muted,#888);margin-top:5px;line-height:1.5}',
            '.hc-btn{padding:7px 16px;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .15s}',
            '.hc-btn:disabled{opacity:.55;cursor:not-allowed}',
            '.hc-btn-primary{background:var(--enum-blue-bg,#4a90e2);color:var(--enum-blue-fg,#fff)}',
            '.hc-btn-primary:hover:not(:disabled){opacity:.85}',
            '.hc-btn-danger{background:var(--enum-red-bg,#fee2e2);color:var(--enum-red-fg,#c00)}',
            '.hc-btn-danger:hover:not(:disabled){opacity:.8}',
            '.hc-btn-wide{width:100%;padding:10px;font-size:14px}',
            '.hc-error{color:var(--enum-red-fg,#c00);font-size:13px;text-align:center}',
            '.hc-link{color:var(--link-color,#4a90e2);text-decoration:none}',
            '.hc-link:hover{text-decoration:underline}',
        ].join('\n');
    }
}
