import { createRequire as createModuleRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { errorName } from "./reader.mts";
import type { TrayPort } from "./tray.mts";

type NativeIcon = object;
type NativeTray = {
  setTooltip(value: string): void;
  setIcon(icon: NativeIcon): void;
  setVisible(visible: boolean): void;
};
type Native = {
  initialize(): void;
  update(): void;
  Icon: { fromRgba(pixels: Buffer, width: number, height: number): NativeIcon };
  TrayIconBuilder: new () => {
    withIcon(icon: NativeIcon): InstanceType<Native["TrayIconBuilder"]>;
    withTooltip(text: string): InstanceType<Native["TrayIconBuilder"]>;
    build(): NativeTray;
  };
};

export function windowsTray(): TrayPort {
  if (!["x64", "arm64"].includes(process.arch))
    throw new Error("Unsupported tray architecture");
  // The package's ESM entry contains CommonJS; load its pinned native export directly.
  const native: Native = createModuleRequire(import.meta.url)(
    fileURLToPath(
      new URL(
        `./node_modules/tray-icon-node/tray-icon-node.win32-${process.arch}-msvc.node`,
        import.meta.url,
      ),
    ),
  );
  native.initialize();
  const icon = (warning: boolean) => {
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let row = 0; row < 16; row++) {
      for (let column = 0; column < 16; column++) {
        const offset = (row * 16 + column) * 4;
        const mark =
          column >= 7 && column <= 8 && row >= 3 && row <= 12 && row !== 10;
        pixels.set(
          mark
            ? [255, 255, 255, 255]
            : warning
              ? [190, 85, 0, 255]
              : [0, 105, 90, 255],
          offset,
        );
      }
    }
    return native.Icon.fromRgba(pixels, 16, 16);
  };
  const normal = icon(false);
  const warning = icon(true);
  const tray = new native.TrayIconBuilder()
    .withIcon(normal)
    .withTooltip("Guild OS: Waiting for upload")
    .build();
  let failed = false;
  const protect = (operation: () => void) => {
    if (failed) return;
    try {
      operation();
    } catch (error) {
      failed = true;
      clearInterval(timer);
      console.error(`Tray unavailable: ${errorName(error)}`);
      try {
        tray.setVisible(false);
      } catch (error) {
        console.error(`Tray cleanup failed: ${errorName(error)}`);
      }
    }
  };
  const timer = setInterval(() => protect(() => native.update()), 16);
  timer.unref();
  return {
    show(state) {
      protect(() => {
        tray.setTooltip(state.tooltip);
        tray.setIcon(state.warning ? warning : normal);
      });
    },
    close() {
      clearInterval(timer);
      protect(() => tray.setVisible(false));
    },
  };
}
