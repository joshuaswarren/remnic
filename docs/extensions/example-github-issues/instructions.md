# GitHub Issues Memory Extension

This extension produces **reference** memories from GitHub issues.

## Memory Format

Each memory represents a single GitHub issue or pull request and contains:

- **Title**: The issue title
- **State**: open, closed, or merged
- **Labels**: Comma-separated label names
- **Repository**: owner/repo format
- **Body excerpt**: First 500 characters of the issue body

## Consolidation Guidance

When consolidating memories from this extension:

1. Group by repository first, then by label similarity
2. Closed/merged issues with the same root cause should merge into a single
   "resolved pattern" memory
3. Open issues should remain as individual reference memories
4. Preserve issue numbers in consolidated memories for traceability

## Importance Signals

- Issues with "critical" or "security" labels: high importance
- Issues with "bug" label: medium importance
- Feature requests and enhancements: low importance
- Stale issues (no activity > 90 days): candidate for archival
