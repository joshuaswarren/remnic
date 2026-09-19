export class ConnectionPool {
  private resourceQueue: string[] = [];

  constructor(private size: number) {
    for (let i = 0; i < size; i++) {
      this.resourceQueue.push(`conn_${i}`);
    }
  }

  public acquire(): string | undefined {
    return this.resourceQueue.pop();
  }

  public release(conn: string): void {
    this.resourceQueue.push(conn);
  }
}
