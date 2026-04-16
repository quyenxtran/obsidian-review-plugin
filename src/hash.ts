import { createHash, type BinaryLike } from "node:crypto";

import type { Sha256Hash } from "./types";

export function sha256(value: BinaryLike): Sha256Hash {
  return createHash("sha256").update(value).digest("hex");
}
