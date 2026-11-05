import { type Expression, parse } from "luaparse";

export const MAX_SAVED_VARIABLES_BYTES = 64 * 1024 * 1024;

export class SavedVariablesError extends Error {
  constructor(name: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = name;
  }
}

export type LuaData =
  | string
  | number
  | boolean
  | null
  | { [key: string]: LuaData };

function literal(expression: Expression): LuaData {
  switch (expression.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
      return expression.value;
    case "UnaryExpression":
      if (
        expression.operator === "-" &&
        expression.argument.type === "NumericLiteral"
      ) {
        return -expression.argument.value;
      }
      break;
    case "TableConstructorExpression": {
      const table: Record<string, LuaData> = {};
      let position = 1;
      for (const field of expression.fields) {
        const key =
          field.type === "TableValue"
            ? position++
            : field.type === "TableKeyString"
              ? field.key.name
              : literal(field.key);
        if (typeof key !== "string" && typeof key !== "number") {
          throw new SavedVariablesError(
            "SavedVariablesSyntaxError",
            "Table keys must be strings or numbers",
          );
        }
        const value = literal(field.value);
        if (value === null) delete table[String(key)];
        else
          Object.defineProperty(table, String(key), {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }
      return table;
    }
  }
  throw new SavedVariablesError(
    "SavedVariablesSyntaxError",
    `Unsupported Lua expression: ${expression.type}`,
  );
}

export function parseSavedVariables(text: string): Record<string, LuaData> {
  if (Buffer.byteLength(text, "utf8") > MAX_SAVED_VARIABLES_BYTES) {
    throw new SavedVariablesError(
      "SavedVariablesTooLargeError",
      "SavedVariables file exceeds size limit",
    );
  }
  if (!text.trim())
    throw new SavedVariablesError(
      "EmptySavedVariablesError",
      "SavedVariables file is empty",
    );
  try {
    // Byte input lets luaparse decode Lua escapes without rejecting UTF-8 names.
    const chunk = parse(Buffer.from(text).toString("latin1"), {
      encodingMode: "pseudo-latin1",
      comments: false,
    });
    let database: LuaData | undefined;
    for (const statement of chunk.body) {
      if (statement.type !== "AssignmentStatement") {
        throw new SavedVariablesError(
          "SavedVariablesSyntaxError",
          "Expected global assignments",
        );
      }
      for (const [index, variable] of statement.variables.entries()) {
        if (variable.type !== "Identifier")
          throw new SavedVariablesError(
            "SavedVariablesSyntaxError",
            "Expected global name",
          );
        const expression = statement.init[index];
        const value = expression ? literal(expression) : null;
        if (variable.name === "GuildOSDB") database = value;
      }
    }
    if (database === undefined)
      throw new SavedVariablesError(
        "MissingGuildOSDBError",
        "GuildOSDB is missing",
      );
    if (!database || typeof database !== "object")
      throw new SavedVariablesError(
        "SavedVariablesSyntaxError",
        "GuildOSDB must be a table",
      );
    return restoreUtf8(database) as Record<string, LuaData>;
  } catch (error) {
    if (error instanceof SavedVariablesError) throw error;
    throw new SavedVariablesError(
      "SavedVariablesSyntaxError",
      "Invalid SavedVariables Lua",
      { cause: error },
    );
  }
}

function restoreUtf8(value: LuaData): LuaData {
  if (typeof value === "string")
    return Buffer.from(value, "latin1").toString("utf8");
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      Buffer.from(key, "latin1").toString("utf8"),
      restoreUtf8(child),
    ]),
  );
}
