import { inflateRawSync } from "node:zlib";
import { SavedVariablesError } from "./saved-variables.mts";

export const MAX_COMPANION_ENCODED_CHARACTERS = 1_000_000;
export const MAX_COMPANION_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_COMPANION_JSON_DEPTH = 64;
export const MAX_COMPANION_JSON_CONTAINERS = 100_000;

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
  if (encoded.length % 4 === 1)
    throw new Error("Invalid EncodeForPrint length");
  const bytes = Buffer.alloc(Math.floor((encoded.length * 6) / 8));
  let offset = 0;
  let cache = 0;
  let bits = 0;
  for (const character of encoded) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) throw new Error("Invalid EncodeForPrint character");
    cache += value * 2 ** bits;
    bits += 6;
    while (bits >= 8) {
      bytes[offset++] = cache % 256;
      cache = Math.floor(cache / 256);
      bits -= 8;
    }
  }
  return bytes;
}

function checkJsonBounds(text: string): void {
  let depth = 0;
  let containers = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "[" || character === "{") {
      depth++;
      containers++;
      if (
        depth > MAX_COMPANION_JSON_DEPTH ||
        containers > MAX_COMPANION_JSON_CONTAINERS
      ) {
        throw new Error("Companion JSON exceeds container limits");
      }
    } else if (character === "]" || character === "}") {
      depth--;
    }
  }
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
    if (fields.__companion.length > MAX_COMPANION_ENCODED_CHARACTERS) {
      throw new Error("Companion export exceeds encoded length limit");
    }
    const json = inflateRawSync(decodeForPrint(fields.__companion.slice(9)), {
      maxOutputLength: MAX_COMPANION_JSON_BYTES,
    });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(json);
    checkJsonBounds(text);
    return JSON.parse(text);
  } catch (error) {
    throw new SavedVariablesError(
      "InvalidCompanionError",
      "Invalid compressed companion payload",
      { cause: error },
    );
  }
}
