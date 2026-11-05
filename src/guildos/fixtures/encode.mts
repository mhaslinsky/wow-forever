import { deflateRawSync } from "node:zlib";

export function encode(payload: unknown): string {
  return encodeBytes(Buffer.from(JSON.stringify(payload)));
}
export function encodeBytes(bytes: Buffer): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()";
  let cache = 0,
    bits = 0,
    output = "GOSCOMP1:";
  for (const byte of deflateRawSync(bytes)) {
    cache += byte * 2 ** bits;
    bits += 8;
    while (bits >= 6) {
      output += alphabet[cache % 64];
      cache = Math.floor(cache / 64);
      bits -= 6;
    }
  }
  if (bits) output += alphabet[cache];
  return output;
}
