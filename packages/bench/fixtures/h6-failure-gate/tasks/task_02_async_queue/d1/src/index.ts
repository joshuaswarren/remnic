export class TaskQueue {
  private activeTaskCount = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor(private readonly maxConcurrency: number) {}

  public push(task: () => Promise<void>): void {
    this.queue.push(task);
    this.process();
  }

  private process(): void {
    const task = this.queue.shift();
    if (task) {
      this.activeTaskCount++;
      task().finally(() => {
        this.activeTaskCount--;
        this.process();
      });
    }
  }
}
