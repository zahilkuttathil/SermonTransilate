/**
 * chunkBatcher.js
 *
 * Collects items added rapidly (e.g. live transcript segments needing translation)
 * and processes them in a single batch after a quiet period.
 *
 * Usage:
 *   const batcher = new ChunkBatcher(async (items) => translateMany(items), 600);
 *   batcher.add(segmentId);   // debounces processing
 *   await batcher.flush();    // force immediate process
 */
export class ChunkBatcher {
  /**
   * @param {Function} processFn - async (items: T[]) => void  — called with batched items
   * @param {number}   delayMs   - quiet-period before auto-flush (default 600ms)
   */
  constructor(processFn, delayMs = 600) {
    this._processFn = processFn;
    this._delayMs   = delayMs;
    this._queue     = [];
    this._timer     = null;
    this._running   = false;
  }

  /**
   * Add an item to the batch queue.
   * Resets the debounce timer.
   * @param {*} item
   */
  add(item) {
    this._queue.push(item);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), this._delayMs);
  }

  /**
   * Force immediate processing of all queued items.
   * Safe to call even if queue is empty.
   */
  async flush() {
    clearTimeout(this._timer);
    if (!this._queue.length || this._running) return;

    const batch = this._queue.splice(0);
    this._running = true;
    try {
      await this._processFn(batch);
    } catch (err) {
      console.error('[ChunkBatcher] flush error:', err);
    } finally {
      this._running = false;
      // If items were added while we were running, schedule another flush
      if (this._queue.length) {
        this._timer = setTimeout(() => this.flush(), this._delayMs);
      }
    }
  }

  /** Cancel any pending flush and clear the queue. */
  cancel() {
    clearTimeout(this._timer);
    this._queue = [];
  }
}
