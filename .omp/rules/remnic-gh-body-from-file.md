---
name: remnic-gh-body-from-file
description: "Pass PR/issue bodies to gh from a file, never an inline command-substitution heredoc"
condition:
  - 'body="\$\(cat\s*<<'
  - "body='\\$\\(cat\\s*<<"
globs:
  - "**/*.sh"
  - "**/*.bash"
  - "**/*.md"
  - "**/*.yml"
  - "**/*.yaml"
interruptMode: never
---

Advisory: a PR or issue body built as `-f body="$(cat <<'EOF' ... EOF)"`
is inside double quotes, so the shell expands it before `gh` ever sees
it. Any backtick in the body — and Markdown bodies are full of them,
`--flag`, `path/to/file.ts`, `command --arg` — starts a command
substitution. The usual outcome is not an error: it is a body that
silently arrives truncated or rewritten, because the shell consumed the
backticked spans and whatever they "returned" replaced them.

Observed failure: a PR body of ~1.2 KB landed as 32 characters,
keeping only the fragments between the backticks and a stray `EOF`.
The PR looked created and healthy; only the body was destroyed. It had
to be repaired with a follow-up `PATCH`.

Use a file instead, so no shell expansion happens at all:

    # write the body with a tool that does not interpolate, then:
    gh api -X POST repos/OWNER/REPO/pulls \
      -f title="..." -f head="..." -f base=main \
      -F body=@/tmp/pr-body.md

`gh pr create --body-file <path>` is equivalent for the CLI form. If a
heredoc is unavoidable, quote the delimiter (`<<'EOF'`) AND keep it out
of double quotes — but a file is simpler and cannot regress.
