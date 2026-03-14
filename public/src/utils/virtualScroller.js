/**
 * virtualScroller.js
 *
 * A memory-safe virtual scroll engine for long transcript/translation feeds.
 * At any time only WINDOW_SIZE DOM nodes are rendered, regardless of total count.
 *
 * Algorithm:
 *  - Top and bottom spacer divs simulate the height of off-screen items.
 *  - IntersectionObserver watches sentinels just inside those spacers.
 *  - When a sentinel enters the viewport, the window shifts and re-renders.
 *  - autoScroll mode keeps the view pinned to the latest item (live feed).
 */
export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container         - Scrollable container element
   * @param {HTMLElement} opts.list              - Inner list element (children go here)
   * @param {HTMLElement} opts.spacerTop         - Top spacer element
   * @param {HTMLElement} opts.spacerBottom      - Bottom spacer element
   * @param {Function}    opts.fetchPage         - async (windowStart, windowSize) => item[]
   * @param {Function}    opts.renderItem        - (item) => HTMLElement
   * @param {number}      [opts.windowSize=8]    - Max DOM nodes to keep rendered
   * @param {number}      [opts.itemHeight=72]   - Estimated item height (px) for spacers
   */
  constructor({ container, list, spacerTop, spacerBottom, fetchPage, renderItem, windowSize = 8, itemHeight = 72 }) {
    this._container   = container;
    this._list        = list;
    this._spacerTop   = spacerTop;
    this._spacerBottom = spacerBottom;
    this._fetchPage   = fetchPage;
    this._renderItem  = renderItem;
    this._windowSize  = windowSize;
    this._itemHeight  = itemHeight;

    this._windowStart = 0;   // index of first rendered item
    this._total       = 0;   // total known item count
    this._rendering   = false;
    this.autoScroll   = true;

    this._renderedItems = [];

    this._setupObserver();
    this._setupScrollListener();
  }

  // ── Setup ───────────────────────────────────────────────────────────────

  _setupObserver() {
    // Top sentinel — a thin div just inside the top spacer
    this._sentinelTop = document.createElement('div');
    this._sentinelTop.className = 'vs-sentinel vs-sentinel--top';
    this._spacerTop.after(this._sentinelTop);

    // Bottom sentinel — a thin div just inside the bottom spacer
    this._sentinelBottom = document.createElement('div');
    this._sentinelBottom.className = 'vs-sentinel vs-sentinel--bottom';
    this._spacerBottom.before(this._sentinelBottom);

    this._observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        if (entry.target === this._sentinelTop && this._windowStart > 0) {
          // Scroll UP — shift window back
          this._windowStart = Math.max(0, this._windowStart - this._windowSize);
          this._render();
        }
        if (entry.target === this._sentinelBottom) {
          const nextStart = this._windowStart + this._windowSize;
          if (nextStart < this._total) {
            // Scroll DOWN — shift window forward
            this._windowStart = Math.min(this._total - this._windowSize, nextStart);
            this._render();
          }
        }
      });
    }, { root: this._container, threshold: 0 });

    this._observer.observe(this._sentinelTop);
    this._observer.observe(this._sentinelBottom);
  }

  _setupScrollListener() {
    this._container.addEventListener('scroll', () => {
      const distFromBottom =
        this._container.scrollHeight -
        this._container.scrollTop -
        this._container.clientHeight;
      // Resume auto-scroll when user scrolls back to within 80px of bottom
      this.autoScroll = distFromBottom < 80;
    }, { passive: true });
  }

  // ── Render ──────────────────────────────────────────────────────────────

  async _render() {
    if (this._rendering) return;
    this._rendering = true;
    try {
      const items = await this._fetchPage(this._windowStart, this._windowSize);

      // Update spacer heights to represent off-screen items
      const aboveCount = this._windowStart;
      const belowCount = Math.max(0, this._total - this._windowStart - items.length);
      this._spacerTop.style.height    = `${aboveCount * this._itemHeight}px`;
      this._spacerBottom.style.height = `${belowCount * this._itemHeight}px`;

      // Recycle rendered nodes
      this._renderedItems.forEach(el => el.remove());
      this._renderedItems = [];

      items.forEach(item => {
        const el = this._renderItem(item);
        this._sentinelBottom.before(el);
        this._renderedItems.push(el);
      });
    } finally {
      this._rendering = false;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Call when the total count of items increases (new segment added).
   * If autoScroll is on, advances window to show the latest item.
   * @param {number} newTotal
   */
  async onNewItem(newTotal) {
    this._total = newTotal;
    if (this.autoScroll) {
      this._windowStart = Math.max(0, newTotal - this._windowSize);
      await this._render();
      this._scrollToBottom();
    }
  }

  /**
   * Force a re-render of the current window (e.g. after translation caches update).
   */
  async refresh() {
    await this._render();
  }

  /**
   * Reset to empty state (new session).
   */
  reset() {
    this._windowStart = 0;
    this._total = 0;
    this.autoScroll = true;
    this._renderedItems.forEach(el => el.remove());
    this._renderedItems = [];
    this._spacerTop.style.height    = '0px';
    this._spacerBottom.style.height = '0px';
  }

  /**
   * Scroll the container to the very bottom.
   */
  _scrollToBottom() {
    this._container.scrollTop = this._container.scrollHeight;
  }

  /** Return current total */
  get total() { return this._total; }

  /** Destroy (disconnect observer) */
  destroy() {
    this._observer.disconnect();
  }
}
