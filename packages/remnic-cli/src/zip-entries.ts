import { crc32, inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Read the named entries of a ZIP archive held in memory. `want` gets each
 * entry name and returns true to extract it. Supports stored and deflated
 * entries; refuses ZIP64, encrypted entries and CRC mismatches by name.
 */
export function readZipEntries(bytes: Uint8Array, want: (name: string) => boolean): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a ZIP archive: no end-of-central-directory record");
  const count = buf.readUInt16LE(end + 10);
  const dirSize = buf.readUInt32LE(end + 12);
  let pos = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirSize === 0xffffffff || pos === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported; unzip the export and pass the JSON file");
  }
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL) throw new Error("corrupt ZIP central directory");
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const packed = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (flags & 1) throw new Error(`ZIP entry '${name}' is encrypted`);
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      throw new Error(`ZIP entry '${name}' needs ZIP64, which is not supported`);
    }
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new Error(`corrupt ZIP local header for '${name}'`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > buf.length) throw new Error(`ZIP entry '${name}' is truncated`);
    const body = buf.subarray(start, start + packed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body);
    else throw new Error(`ZIP entry '${name}' uses compression method ${method}; only stored and deflate are supported`);
    if (data.length !== size || (crc32(data) >>> 0) !== crc) throw new Error(`ZIP entry '${name}' failed its CRC check`);
    out.set(name, data);
  }
  return out;
}
