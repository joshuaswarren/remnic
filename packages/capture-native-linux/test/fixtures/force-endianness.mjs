import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const forcedEndianness = process.env.FAKE_PCM_ENDIANNESS;
if (forcedEndianness !== "BE" && forcedEndianness !== "LE") {
  throw new Error("FAKE_PCM_ENDIANNESS must be BE or LE");
}
os.endianness = () => forcedEndianness;
syncBuiltinESMExports();
