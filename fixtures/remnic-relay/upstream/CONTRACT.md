# Checkout token lifecycle contract

Status: accepted and authoritative

The checkout service owns one token per checkout session. The first request
mints that token. Retries in the same session reuse the existing token while
it remains valid. After explicit expiry, the next request mints exactly one
replacement token, which subsequent retries reuse.

This contract supersedes the early prototype behavior that rotated a token on
every request. Rotation on an ordinary retry breaks idempotency and is not a
supported implementation.
