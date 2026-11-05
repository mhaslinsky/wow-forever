export function startReaderSession(ports: {
  watch(): () => void;
  tray(): () => void;
  changed(): void;
  stop(): void;
}): () => void {
  let stopWatch: (() => void) | undefined;
  let stopTray: (() => void) | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    ports.stop();
    stopWatch?.();
    stopTray?.();
  };
  try {
    stopWatch = ports.watch();
    stopTray = ports.tray();
    ports.changed();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
