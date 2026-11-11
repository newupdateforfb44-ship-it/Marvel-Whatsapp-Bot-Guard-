// Anti-ban send queue: messages leave one at a time with a small random pause between them.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SendQueue {
  constructor({ min = 700, max = 1800, maxLen = 40 } = {}) {
    this.min = min;
    this.max = max;
    this.maxLen = maxLen;
    this.items = [];
    this.busy = false;
  }

  // fn must return a promise. Resolves with its result, or null if it failed or the queue was full.
  add(fn) {
    if (this.items.length >= this.maxLen) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.items.push({ fn, resolve });
      this.#run();
    });
  }

  clear() {
    for (const i of this.items.splice(0)) i.resolve(null);
  }

  async #run() {
    if (this.busy) return;
    this.busy = true;
    while (this.items.length) {
      const { fn, resolve } = this.items.shift();
      try {
        resolve(await fn());
      } catch (e) {
        console.error('send failed:', e.message);
        resolve(null);
      }
      if (this.items.length) await sleep(this.min + Math.random() * (this.max - this.min));
    }
    this.busy = false;
  }
}
