---
"@remnic/core": patch
Stability: stable
---

Fixed support-passport grant-store path safety on Windows: the no-follow ancestor check no longer rejects a legitimate stable memory directory with `support passport memory directory must be a stable directory`. Windows has no POSIX directory-fd root (`/proc/self/fd`, `/dev/fd`), so directory pinning there now degrades to the resolved stable path while the lstat-based no-follow ancestor walk, dev/ino stability asserts, and containment checks stay in force. POSIX platforms are unchanged and still pin through the descriptor root. Closes #3069.
