import type { Status } from "./reader.mts";

export type TrayState = { tooltip: string; warning: boolean };
export type TrayPort = {
  show(state: TrayState): void;
  close(): void;
};

export function trayState(status: Status): TrayState {
  const success = status.lastSuccess;
  const failure = status.lastFailure;
  if (failure && (!success || failure.at >= success.at)) {
    return {
      tooltip: `Guild OS: ${failure.error}`.slice(0, 127),
      warning: true,
    };
  }
  return {
    tooltip: success
      ? `Guild OS: ${success.outcome}`.slice(0, 127)
      : "Guild OS: Waiting for upload",
    warning: false,
  };
}

export function refreshTray(tray: TrayPort, readStatus: () => string): void {
  try {
    const status: unknown = JSON.parse(readStatus());
    if (!status || typeof status !== "object" || Array.isArray(status))
      throw new Error("Invalid status");
    const { lastSuccess, lastFailure } = status as Status;
    for (const [event, field] of [
      [lastSuccess, "outcome"],
      [lastFailure, "error"],
    ] as const) {
      if (
        event !== undefined &&
        (!event ||
          typeof event.at !== "number" ||
          !Number.isFinite(event.at) ||
          typeof (event as unknown as Record<string, unknown>)[field] !==
            "string")
      )
        throw new Error("Invalid status");
    }
    tray.show(trayState(status));
  } catch {
    tray.show({ tooltip: "Guild OS: Status unavailable", warning: true });
  }
}
