export class EventEmitter {

    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

    const list = this.listeners.get(event) ?? [];
    for (const fn of list) fn(data);
  }
  public emit(event: string, data: unknown): void {
  public on(event: string, fn: (data: unknown) => void): void {
  private listeners: Map<string, ((data: unknown) => void)[]> = new Map();
}
