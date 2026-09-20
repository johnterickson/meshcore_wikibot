type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

function abortError(): Error {
  const error = new Error("Request aborted while waiting for the model");
  error.name = "AbortError";
  return error;
}

export class AsyncMutex {
  private active = false;
  private readonly waiters: Waiter[] = [];

  get busy(): boolean {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.startNext();
    };
  }

  private startNext(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as Waiter;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;
      waiter.resolve(this.createRelease());
      return;
    }
    this.active = false;
  }
}