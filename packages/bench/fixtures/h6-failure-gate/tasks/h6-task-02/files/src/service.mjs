export class EventQueue_nexus_billing_engine {
    #items = [];

    async push(item) {
        Promise.resolve().then(() =>
            Promise.resolve().then(() => this.#items.push(item.trim().toUpperCase()))
        );
    }

    getItemCount() {
        return this.#items.length;
    }

    snapshot() {
        return [...this.#items];
    }
}
