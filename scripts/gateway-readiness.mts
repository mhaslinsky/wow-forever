export type UnitStatus = {
  ActiveState: string;
  SubState: string;
  NRestarts: string;
};
export async function waitForGateway(options: {
  restartedAt: number;
  unit: () => Promise<UnitStatus>;
  heartbeat: () => Promise<number[]>;
  now: () => number;
  pause: () => Promise<void>;
}) {
  const initial = await options.unit();
  const assertActive = (status: UnitStatus) => {
    if (
      status.ActiveState !== "active" ||
      status.SubState !== "running" ||
      !/^\d+$/.test(status.NRestarts) ||
      status.NRestarts !== initial.NRestarts
    )
      throw new Error("Gateway stopped or restarted during readiness check");
  };
  assertActive(initial);
  const stableSince = options.now();
  while (options.now() - stableSince < 30_000) {
    await options.pause();
    assertActive(await options.unit());
  }
  const deadline = options.now() + 180_000;
  do {
    assertActive(await options.unit());
    const timestamps = await options.heartbeat();
    if (
      timestamps.some(
        (timestamp) =>
          Number.isFinite(timestamp) && timestamp > options.restartedAt,
      )
    )
      return;
    if (options.now() >= deadline) break;
    await options.pause();
  } while (options.now() <= deadline);
  throw new Error("No instance heartbeat after restart within three minutes");
}
