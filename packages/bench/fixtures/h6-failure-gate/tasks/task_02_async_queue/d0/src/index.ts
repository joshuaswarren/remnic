export class TaskQueue {
  private running = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor(private readonly maxConcurrency: number) {}

  public push(task: () => Promise<void>): void {
    this.queue.push(task);
    this.process();
  }

  private process(): void {
    const task = this.queue.shift();
    if (task) {
      this.running++;
      task().finally(() => {
        this.running--;
        this.process();
      });
    }
  }
}
