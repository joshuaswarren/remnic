export class TrieNode {
}

export class TrieStore {

    let curr = this.root;
    for (const ch of word) {
      if (!curr.children.has(ch)) curr.children.set(ch, new TrieNode());
      curr = curr.children.get(ch)!;
    }
    curr.isEnd = true;
  }

    let curr = this.root;
    for (const ch of prefix) {
      if (!curr.children.has(ch)) return false;
      curr = curr.children.get(ch)!;
    }
    return true;
  }
  public startsWith(prefix: string): boolean {
  public insert(word: string): void {
  private root = new TrieNode();
  public isEnd = false;
  public children = new Map<string, TrieNode>();
}
