import type Database from "better-sqlite3";
import { log } from "../logger.js";

export interface SummaryNode {
  id: string;
  session_id: string;
  depth: number;
  parent_id: string | null;
  summary_text: string;
  token_count: number;
  msg_start: number;
  msg_end: number;
  escalation: number;
  created_at: string;
}

export class LcmDag {
  constructor(private readonly db: Database.Database) {}

  /** Insert a new summary node. */
  insertNode(node: Omit<SummaryNode, "created_at">): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO lcm_summary_nodes (id, session_id, depth, parent_id, summary_text, token_count, msg_start, msg_end, escalation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        node.id,
        node.session_id,
        node.depth,
        node.parent_id,
        node.summary_text,
        node.token_count,
        node.msg_start,
        node.msg_end,
        node.escalation,
        now,
      );

    // Keep FTS in sync
    const rowid = this.db
      .prepare("SELECT rowid FROM lcm_summary_nodes WHERE id = ?")
      .get(node.id) as { rowid: number } | undefined;
    if (rowid) {
      this.db
        .prepare("INSERT INTO lcm_summaries_fts (rowid, summary_text) VALUES (?, ?)")
        .run(rowid.rowid, node.summary_text);
    }
  }

  /** Get leaf nodes (depth=0) for a session without a parent yet, ordered by msg_start. */
  getOrphanNodesAtDepth(sessionId: string, depth: number): SummaryNode[] {
    return this.db
      .prepare(
        "SELECT * FROM lcm_summary_nodes WHERE session_id = ? AND depth = ? AND parent_id IS NULL ORDER BY msg_start",
      )
      .all(sessionId, depth) as SummaryNode[];
  }

  /** Get all nodes at a given depth for a session. */
  getNodesAtDepth(sessionId: string, depth: number): SummaryNode[] {
    return this.db
      .prepare(
        "SELECT * FROM lcm_summary_nodes WHERE session_id = ? AND depth = ? ORDER BY msg_start",
      )
      .all(sessionId, depth) as SummaryNode[];
  }

  /** Get child nodes of a parent. */
  getChildren(parentId: string): SummaryNode[] {
    return this.db
      .prepare("SELECT * FROM lcm_summary_nodes WHERE parent_id = ? ORDER BY msg_start")
      .all(parentId) as SummaryNode[];
  }

  /** Get the deepest summary nodes covering a session (highest depth, broadest coverage). */
  getDeepestNodes(sessionId: string): SummaryNode[] {
    const maxDepth = this.db
      .prepare("SELECT MAX(depth) as max_depth FROM lcm_summary_nodes WHERE session_id = ?")
      .get(sessionId) as { max_depth: number | null } | undefined;

    if (!maxDepth?.max_depth && maxDepth?.max_depth !== 0) return [];

    return this.getNodesAtDepth(sessionId, maxDepth.max_depth);
  }

  /** Get the maximum depth for a session. */
  getMaxDepth(sessionId: string): number {
    const row = this.db
      .prepare("SELECT MAX(depth) as max_depth FROM lcm_summary_nodes WHERE session_id = ?")
      .get(sessionId) as { max_depth: number | null } | undefined;
    return row?.max_depth ?? -1;
  }

  /** Get summary nodes that best cover a turn range, preferring higher depth. */
  getCoveringNodes(sessionId: string, fromTurn: number, toTurn: number): SummaryNode[] {
    return this.db
      .prepare(`
        SELECT * FROM lcm_summary_nodes
        WHERE session_id = ?
          AND msg_start <= ?
          AND msg_end >= ?
        ORDER BY depth DESC, msg_start
      `)
      .all(sessionId, toTurn, fromTurn) as SummaryNode[];
  }

  /** Get all nodes for a session, ordered by depth then range. */
  getAllNodes(sessionId: string): SummaryNode[] {
    return this.db
      .prepare(
        "SELECT * FROM lcm_summary_nodes WHERE session_id = ? ORDER BY depth, msg_start",
      )
      .all(sessionId) as SummaryNode[];
  }

  /** Get total node count for a session. */
  getNodeCount(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM lcm_summary_nodes WHERE session_id = ?")
      .get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /** Delete all summary and compaction state for one session. */
  deleteSession(sessionId: string): number {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM lcm_summaries_fts WHERE rowid IN (SELECT rowid FROM lcm_summary_nodes WHERE session_id = ?)",
        )
        .run(sessionId);
      this.db
        .prepare("DELETE FROM lcm_compaction_events WHERE session_id = ?")
        .run(sessionId);
      const result = this.db
        .prepare("DELETE FROM lcm_summary_nodes WHERE session_id = ?")
        .run(sessionId);
      return result.changes;
    });
    return txn();
  }

  /** Delete all summary and compaction state. */
  deleteAll(): number {
    const txn = this.db.transaction(() => {
      this.db.prepare("DELETE FROM lcm_summaries_fts").run();
      this.db.prepare("DELETE FROM lcm_compaction_events").run();
      const result = this.db.prepare("DELETE FROM lcm_summary_nodes").run();
      return result.changes;
    });
    return txn();
  }

  /** Set parent_id for a list of child node IDs. */
  setParent(childIds: string[], parentId: string): void {
    const stmt = this.db.prepare(
      "UPDATE lcm_summary_nodes SET parent_id = ? WHERE id = ?",
    );
    const txn = this.db.transaction(() => {
      for (const childId of childIds) {
        stmt.run(parentId, childId);
      }
    });
    txn();
  }

  /** Record a compaction event. */
  recordCompaction(
    sessionId: string,
    msgBefore: number,
    tokensBefore: number,
    tokensAfter: number,
  ): void {
    this.db
      .prepare(`
        INSERT INTO lcm_compaction_events (session_id, fired_at, msg_before, tokens_before, tokens_after)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(sessionId, new Date().toISOString(), msgBefore, tokensBefore, tokensAfter);
  }

  /** Prune summary nodes for old sessions. */
  pruneOldNodes(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();

    this.db
      .prepare(
        "DELETE FROM lcm_summaries_fts WHERE rowid IN (SELECT rowid FROM lcm_summary_nodes WHERE created_at < ?)",
      )
      .run(cutoff);

    const result = this.db
      .prepare("DELETE FROM lcm_summary_nodes WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }
}
