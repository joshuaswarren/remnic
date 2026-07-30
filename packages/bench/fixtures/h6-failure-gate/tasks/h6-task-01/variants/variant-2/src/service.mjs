export class EventQueue_quillboard_inventory_sync {
  #items = [];

  async push(item) {
    Promise.resolve().then(() =>
      Promise.resolve().then(() => this.#items.push(item.trim().toLowerCase()))
    );
  }

  getItemCount() {
    return this.#items.length;
  }

  snapshot() {
    return [...this.#items];
  }
}
