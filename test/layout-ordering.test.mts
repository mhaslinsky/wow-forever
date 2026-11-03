import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { LiveRole } from "../src/layout/types.mts";
import { fixture, model } from "./layout-model.mts";

test("role model reproduces captured Discord create, tie, boundary and compaction responses", () => {
  const captures = JSON.parse(
    readFileSync(
      new URL("./fixtures/role-ordering.json", import.meta.url),
      "utf8",
    ),
  );
  const server = model();
  const baseline = captures[0].response as Pick<
    LiveRole,
    "id" | "name" | "position" | "managed" | "applicationId"
  >[];
  server.snapshot.guildId = baseline[0].id;
  ok(baseline[2].applicationId);
  server.snapshot.applicationId = baseline[2].applicationId;
  server.snapshot.roles = baseline.map((role) => ({
    permissions: "0",
    color: 0,
    hoist: false,
    mentionable: false,
    ...role,
  }));
  const positions = (roles: LiveRole[]) =>
    roles.map(({ id, position }) => ({ id, position }));
  for (const capture of captures) {
    const { request, response, source } = capture;
    if (request.method === "POST") {
      server.apply({
        kind: "createRole",
        role: {
          ...fixture().roles[2],
          key: request.body.name,
          name: request.body.name,
          permissions: {},
        },
      });
      const created = server.snapshot.roles.at(-1);
      if (!created) throw new Error("Missing model create");
      created.id = response.id;
      server.ids.roles[request.body.name] = response.id;
      equal(created.position, response.position, source);
    } else if (request.method === "PATCH" && Array.isArray(request.body)) {
      if (capture.status === 200) server.reorderRoles(request.body);
      else
        throws(
          () => server.reorderRoles(request.body),
          { code: response.code, message: response.message },
          source,
        );
    } else if (request.method === "DELETE") {
      server.snapshot.roles = server.snapshot.roles.filter(
        (role) => role.id !== request.path.split("/").at(-1),
      );
    }
    if (Array.isArray(response))
      deepEqual(positions(server.snapshot.roles), positions(response), source);
  }
});
