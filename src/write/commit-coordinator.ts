export class ProjectCommitCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  get pendingProjectCount(): number {
    return this.#tails.size;
  }

  async run<T>(projectId: string, action: () => Promise<T> | T): Promise<T> {
    const previous = this.#tails.get(projectId) ?? Promise.resolve();

    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => slot);
    this.#tails.set(projectId, tail);

    await previous.catch(() => undefined);

    try {
      return await action();
    } finally {
      release();
      if (this.#tails.get(projectId) === tail) {
        this.#tails.delete(projectId);
      }
    }
  }

  runPrepared<TPrepared, TResult>(
    projectId: string,
    prepare: () => Promise<TPrepared> | TPrepared,
    commit: (prepared: TPrepared) => Promise<TResult> | TResult
  ): Promise<TResult> {
    const preparation = Promise.resolve()
      .then(prepare)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );

    return this.run(projectId, async () => {
      const prepared = await preparation;
      if (!prepared.ok) throw prepared.error;
      return commit(prepared.value);
    });
  }
}
