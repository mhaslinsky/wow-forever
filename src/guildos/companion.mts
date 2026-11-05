import { inflateRawSync } from "node:zlib";
import { SavedVariablesError } from "./saved-variables.mts";

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()";

// Altered TypeScript port of LibDeflate DecodeForPrint, Haoqian He, 2018-2021.
// The zlib license notice is preserved in LibDeflate.LICENSE.
function decodeForPrint(text: string): Buffer {
  let start = 0;
  let end = text.length;
  while (
    start < end &&
    (text.charCodeAt(start) <= 32 || text.charCodeAt(start) === 127)
  )
    start++;
  while (
    end > start &&
    (text.charCodeAt(end - 1) <= 32 || text.charCodeAt(end - 1) === 127)
  )
    end--;
  const encoded = text.slice(start, end);
  if (encoded.length === 1) throw new Error("Invalid EncodeForPrint length");
  const bytes: number[] = [];
  let cache = 0;
  let bits = 0;
  for (const character of encoded) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) throw new Error("Invalid EncodeForPrint character");
    cache += value * 2 ** bits;
    bits += 6;
    while (bits >= 8) {
      bytes.push(cache % 256);
      cache = Math.floor(cache / 256);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function decodeCompanion(database: unknown): unknown {
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw new SavedVariablesError(
      "InvalidCompanionError",
      "GuildOSDB must be a table",
    );
  }
  const fields = database as Record<string, unknown>;
  if (fields.__companionSelf === true)
    throw new SavedVariablesError(
      "PersonalPackError",
      "Personal packs are unsupported",
    );
  if (
    typeof fields.__companion !== "string" ||
    !fields.__companion.startsWith("GOSCOMP1:")
  ) {
    throw new SavedVariablesError(
      "CompanionPrefixError",
      "Expected GOSCOMP1 prefix",
    );
  }
  try {
    return JSON.parse(
      inflateRawSync(decodeForPrint(fields.__companion.slice(9))).toString(
        "utf8",
      ),
    );
  } catch (error) {
    throw new SavedVariablesError(
      "InvalidCompanionError",
      "Invalid compressed companion payload",
      { cause: error },
    );
  }
}
