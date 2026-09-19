export class ConnectionPool {
  private pool: string[] = [];

  constructor(private size: number) {
    for (let i = 0; i < size; i++) {
      this.pool.push(`conn_${i}`);
    }
  }

  public acquire(): string | undefined {
    return this.pool.pop();
  }

  public release(conn: string): void {
    this.pool.push(conn);
  }
}
