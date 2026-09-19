export class EventEmitter {
  private callbackRegistry: Map<string, ((data: unknown) => void)[]> = new Map();

  public on(event: string, fn: (data: unknown) => void): void {
    const list = this.callbackRegistry.get(event) ?? [];
    list.push(fn);
    this.callbackRegistry.set(event, list);
  }

  public emit(event: string, data: unknown): void {
    const list = this.callbackRegistry.get(event) ?? [];
    for (const fn of list) fn(data);
  }
}
