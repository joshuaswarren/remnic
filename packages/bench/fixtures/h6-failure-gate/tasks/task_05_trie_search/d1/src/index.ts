export class TrieNode {
  public subNodeMap = new Map<string, TrieNode>();
  public isEnd = false;
}

export class TrieStore {
  private root = new TrieNode();

  public insert(word: string): void {
    let curr = this.root;
    for (const ch of word) {
      if (!curr.subNodeMap.has(ch)) curr.subNodeMap.set(ch, new TrieNode());
      curr = curr.subNodeMap.get(ch)!;
    }
    curr.isEnd = true;
  }

  public startsWith(prefix: string): boolean {
    let curr = this.root;
    for (const ch of prefix) {
      if (!curr.subNodeMap.has(ch)) return false;
      curr = curr.subNodeMap.get(ch)!;
    }
    return true;
  }
}
