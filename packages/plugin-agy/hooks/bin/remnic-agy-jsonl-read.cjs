"use strict";

// Bounded read for agy JSONL transcripts (#3454 CodeRabbit): one descriptor,
// never more than maxBytes + 1 bytes returned. fs.readSync may return short of
// the request before EOF (network filesystems), so loop until a read returns
// zero or the buffer is full. The caller rejects when the result exceeds
// maxBytes.

const fs = require("fs");

function readBounded(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(maxBytes + 1);
  try {
    let off = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
      if (off >= buf.length) break;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readBounded };
