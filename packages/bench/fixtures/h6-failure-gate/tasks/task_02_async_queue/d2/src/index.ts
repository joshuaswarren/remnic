export class TaskQueue {

  constructor(private readonly maxConcurrency: number) {}

    this.queue.push(task);
    this.process();
  }

    const task = this.queue.shift();
    if (task) {
      this.running++;
      task().finally(() => {
        this.running--;
        this.process();
      });
    }
  }
  private process(): void {
  public push(task: () => Promise<void>): void {
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
}
