/**
 * Keeps one managed-session stop in flight across concurrent quit requests.
 * The cache is cleared as soon as the real stop settles so a later quit checks
 * the sessions that exist then, even if this quit attempt already timed out.
 */
export class QuitSessionStopCoordinator {
  private pending: Promise<void> | undefined;

  run(start: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;

    const operation = Promise.resolve().then(start);
    this.pending = operation;
    void operation.then(
      () => {
        if (this.pending === operation) this.pending = undefined;
      },
      () => {
        if (this.pending === operation) this.pending = undefined;
      },
    );
    return operation;
  }
}
