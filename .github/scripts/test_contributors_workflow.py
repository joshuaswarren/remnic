"""The bot-authored registry PR must name its supported merge path.

A pull request opened with GITHUB_TOKEN does not start the normal
pull_request workflows automatically, and the bot author has no review
seat, so the required ai-reviewers gate can never pass on it (issue
#3495). The pull request body must say so and must name the supported
path — verify the generated diff and carry it in a normal maintainer PR —
or the next registry update will sit blocked with no instruction attached.
"""

import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.normpath(os.path.join(HERE, "..", "workflows", "contributors.yml"))


def pr_body_block():
    """Return only the heredoc/echo block that builds pr-body.md."""
    with open(WORKFLOW, encoding="utf-8") as handle:
        text = handle.read()
    start = text.index('echo "Generated [CONTRIBUTORS.md]')
    end = text.index("> pr-body.md", start)
    return text[start:end]


class BotPrBodyCarryPath(unittest.TestCase):
    def test_body_says_the_bot_pr_cannot_pass_review(self):
        body = pr_body_block()
        self.assertIn("github-actions[bot]", body)
        self.assertIn("cannot pass", body)
        self.assertIn("ai-reviewers gate", body)
        # GITHUB_TOKEN runs can queue for maintainer approval, so the claim
        # must be qualified; an unqualified "does not start" is inaccurate.
        self.assertIn("automatically", body.lower())

    def test_body_names_the_maintainer_carry_path(self):
        body = pr_body_block().lower()
        self.assertIn("carry it in a", body)
        self.assertIn("maintainer pull request", body)
        self.assertIn("only after the replacement merges", body)

    def test_body_references_the_governing_issue(self):
        self.assertIn("3495", pr_body_block())


if __name__ == "__main__":
    unittest.main()
