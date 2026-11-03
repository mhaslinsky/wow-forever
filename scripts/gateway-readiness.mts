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

export function gatewayDeployCommands(
  bucket: string,
  key: string,
  digest: string,
) {
  return [
    "set -eu",
    `aws s3 cp s3://${bucket}/${key} /opt/wow-forever-gateway/next.mjs --region us-east-1`,
    `echo '${digest}  /opt/wow-forever-gateway/next.mjs' | sha256sum -c -`,
    "mv /opt/wow-forever-gateway/next.mjs /opt/wow-forever-gateway/index.mjs",
    "chmod 0644 /opt/wow-forever-gateway/index.mjs",
    "systemctl enable wow-forever-gateway",
    "systemctl restart wow-forever-gateway",
    "systemctl is-active --quiet wow-forever-gateway",
  ];
}
