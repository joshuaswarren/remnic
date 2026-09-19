export class TrieNode {
  public children = new Map<string, TrieNode>();
  public isEnd = false;
}

export class TrieStore {
  private root = new TrieNode();

  public insert(word: string): void {
    let curr = this.root;
    for (const ch of word) {
      if (!curr.children.has(ch)) curr.children.set(ch, new TrieNode());
      curr = curr.children.get(ch)!;
    }
    curr.isEnd = true;
  }

  public startsWith(prefix: string): boolean {
    let curr = this.root;
    for (const ch of prefix) {
      if (!curr.children.has(ch)) return false;
      curr = curr.children.get(ch)!;
    }
    return true;
  }
}
