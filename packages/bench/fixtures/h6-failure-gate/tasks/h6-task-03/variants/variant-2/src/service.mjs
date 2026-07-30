export class EventQueue_starlight_auth_vault {
  #items = [];

  async push(item) {
    Promise.resolve().then(() =>
      Promise.resolve().then(() => this.#items.push(item.trim().replaceAll(" ", "-")))
    );
  }

  getItemCount() {
    return this.#items.length;
  }

  snapshot() {
    return [...this.#items];
  }
}
