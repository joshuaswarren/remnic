export class EventEmitter {
  private listeners: Map<string, ((data: unknown) => void)[]> = new Map();

  public on(event: string, fn: (data: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  public emit(event: string, data: unknown): void {
    const list = this.listeners.get(event) ?? [];
    for (const fn of list) fn(data);
  }
}
