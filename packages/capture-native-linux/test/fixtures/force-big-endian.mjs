import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

os.endianness = () => "BE";
syncBuiltinESMExports();
