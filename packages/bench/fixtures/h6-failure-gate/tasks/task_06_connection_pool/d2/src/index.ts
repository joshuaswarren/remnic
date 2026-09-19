export class ConnectionPool {

  constructor(private size: number) {
    for (let i = 0; i < size; i++) {
      this.pool.push(`conn_${i}`);
    }
  }

    return this.pool.pop();
  }

    this.pool.push(conn);
  }
  public release(conn: string): void {
  public acquire(): string | undefined {
  private pool: string[] = [];
}
