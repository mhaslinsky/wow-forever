import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import { encode, encodeBytes } from "./fixtures/encode.mts";
import { decodeCompanion, normalize, parseSavedVariables } from "./index.mts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const sample = decodeCompanion(
  parseSavedVariables(fixture("guild.lua")),
) as Record<string, unknown>;
const forever: Record<string, unknown> = { ...sample, game: "FOREVER" };

test("genuine addon bytes decode and kept sections normalize", () => {
  assert.equal(sample.game, "ANNIVERSARY");
  const snapshot = normalize(forever);
  assert.deepEqual(snapshot, JSON.parse(fixture("snapshot.json")));
  assert.deepEqual(
    parseSavedVariables(
      'GuildOSDB = { ["é"] = { "a\\n\\065", -2.5, true, false, nil }, absent = nil }',
    ),
    { é: { "1": "a\nA", "2": -2.5, "3": true, "4": false } },
  );
});

test("unsupported files and payload shapes fail by name", () => {
  const wire = encode({});
  const invalidLength = wire.padEnd(
    wire.length + ((1 - ((wire.length - 9) % 4) + 4) % 4),
    "a",
  );
  const cases: [() => unknown, string][] = [
    [
      () => parseSavedVariables(" ".repeat(64 * 1024 * 1024 + 1)),
      "SavedVariablesTooLargeError",
    ],
    ...[
      wire.padEnd(1_000_001, "a"),
      invalidLength,
      encodeBytes(Buffer.from([34, 255, 34])),
      encode(" ".repeat(8 * 1024 * 1024)),
      encodeBytes(
        Buffer.from(
          `${JSON.stringify(forever).slice(0, -1)},"junk":${"[".repeat(65)}0${"]".repeat(65)}}`,
        ),
      ),
    ].map((__companion): [() => unknown, string] => [
      () => decodeCompanion({ __companion }),
      "InvalidCompanionError",
    ]),
    ...["", " \n\t"].map((text): [() => unknown, string] => [
      () => parseSavedVariables(text),
      "EmptySavedVariablesError",
    ]),
    [() => parseSavedVariables("Other = {}"), "MissingGuildOSDBError"],
    ...[
      "GuildOSDB = {",
      'GuildOSDB = os.execute("bad")',
      "GuildOSDB = true",
    ].map((text): [() => unknown, string] => [
      () => parseSavedVariables(text),
      "SavedVariablesSyntaxError",
    ]),
    [
      () => decodeCompanion(parseSavedVariables(fixture("personal.lua"))),
      "PersonalPackError",
    ],
    [() => decodeCompanion({}), "CompanionPrefixError"],
    ...["GOSCOMP1:!", "GOSCOMP1:aa"].map(
      (__companion): [() => unknown, string] => [
        () => decodeCompanion({ __companion }),
        "InvalidCompanionError",
      ],
    ),
    [() => normalize(sample), "UnsupportedGameError"],
    [() => normalize({ ...forever, fmt: "other" }), "UnsupportedFormatError"],
    [() => normalize({ ...forever, v: 15 }), "UnsupportedPayloadVersionError"],
    [() => normalize({ ...forever, count: 0 }), "MemberCountMismatchError"],
    ...[
      null,
      { ...forever, members: {} },
      { ...forever, loot: {} },
      { ...forever, loot: undefined },
    ].map((payload): [() => unknown, string] => [
      () => normalize(payload),
      "InvalidPayloadShapeError",
    ]),
  ];
  for (const section of ["members", "loot"] as const) {
    const entries = forever[section] as Record<string, unknown>[];
    for (const field of [
      ...Object.keys(normalize(forever)[section][0]),
      ...(section === "members" ? ["main", "joinedAt"] : []),
    ]) {
      cases.push([
        () =>
          normalize({
            ...forever,
            [section]: [{ ...entries[0], [field]: null }, ...entries.slice(1)],
          }),
        "InvalidPayloadShapeError",
      ]);
    }
  }
  for (const [run, name] of cases) assert.throws(run, { name });
});

test("generated valid payloads survive encode, decode and normalization", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          name: fc.string(),
          level: fc.nat(80),
          joinedAt: fc.nat(),
          prefRoles: fc.array(fc.string()),
        }),
        { maxLength: 8 },
      ),
      (generated) => {
        const members = generated.map((fields, index) => ({
          ...(forever.members as object[])[0],
          ...fields,
          key: `member-${index}`,
          main: "main",
        }));
        const payload = {
          ...forever,
          members,
          count: members.length,
          loot: members.length ? forever.loot : [],
        };
        assert.deepEqual(
          normalize(
            decodeCompanion(
              parseSavedVariables(
                `GuildOSDB = { __companion = "${encode(payload)}" }`,
              ),
            ),
          ),
          normalize(payload),
        );
      },
    ),
  );
});
