#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  adopt,
  applyLayout,
  inspectPlan,
  planBinding,
} from "../src/layout/executor.mts";
import { readback } from "../src/layout/readback.mts";
import { parseLayout } from "../src/layout/schema.mts";
import { emptyState, withStateLock } from "../src/layout/state.mts";
import {
  discordTransport,
  fetchSnapshot,
  keychainToken,
} from "../src/layout/transport.mts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    layout: { type: "string", default: "discord/layout.yaml" },
    state: {
      type: "string",
      default: join(homedir(), ".config/wow-forever/layout-state.json"),
    },
    plan: { type: "string" },
    guild: { type: "string" },
    application: { type: "string" },
    "allow-delete": { type: "boolean", default: false },
    help: { type: "boolean" },
  },
});
try {
  if (values.help) {
    console.log(
      "Usage: layout.mts adopt|plan|apply|readback --guild ID --application ID [--layout FILE] [--state FILE] [--plan FILE] [--allow-delete]",
    );
  } else {
    const command = positionals[0];
    if (
      positionals.length !== 1 ||
      !["adopt", "plan", "apply", "readback"].includes(command)
    )
      throw new Error("Choose adopt, plan, apply, or readback");
    if (!values.guild || !values.application)
      throw new Error("--guild and --application are required");
    if ((command === "plan" || command === "apply") && !values.plan)
      throw new Error("--plan is required");
    const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const statePath = resolve(values.state);
    const requireOutside = (target: string, label: string) => {
      let ancestor = dirname(resolve(target));
      let suffix = basename(resolve(target));
      while (true) {
        try {
          ancestor = realpathSync(ancestor);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const parent = resolve(ancestor, "..");
          if (parent === ancestor) throw error;
          suffix = join(basename(ancestor), suffix);
          ancestor = parent;
        }
      }
      const part = relative(realpathSync(repo), join(ancestor, suffix));
      if (
        part === "" ||
        (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
      )
        throw new Error(`${label} must be outside the repository`);
    };
    requireOutside(statePath, "State");
    if (command === "plan" || command === "apply")
      requireOutside(values.plan as string, "Plan");
    const layout = parseLayout(readFileSync(values.layout, "utf8"));
    const port = discordTransport(keychainToken());
    const target = { guildId: values.guild, applicationId: values.application };
    const result =
      command === "apply"
        ? await applyLayout({
            ...target,
            layout,
            statePath,
            planPath: values.plan as string,
            allowDelete: values["allow-delete"],
            port,
          })
        : await withStateLock(statePath, async (locked) => {
            const snapshot = await fetchSnapshot(port, target);
            let state: ReturnType<typeof emptyState>;
            try {
              state = locked.read();
            } catch (error) {
              if (
                command !== "adopt" ||
                (error as NodeJS.ErrnoException).code !== "ENOENT"
              )
                throw error;
              state = emptyState(target.guildId);
            }
            if (state.guildId !== target.guildId)
              throw new Error("Target guild differs");
            if (command === "adopt") {
              locked.write(adopt(layout, snapshot, state));
              return { ok: true };
            }
            if (command === "readback")
              return readback(layout, snapshot, state.ids);
            const result = inspectPlan(layout, snapshot, state);
            locked.savePlan(
              values.plan as string,
              planBinding(layout, state, result),
              result,
            );
            return result;
          });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Layout command failed",
  );
  process.exitCode = 1;
}
