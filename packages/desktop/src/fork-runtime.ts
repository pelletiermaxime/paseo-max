import path from "node:path";
import os from "node:os";
import { app } from "electron";

export const isPaseoMax = app.isPackaged && app.getName() === "Paseo Max";

// Capture explicit fork overrides before a login shell can restore upstream values.
const forkEnvironment = {
  PASEO_HOME: process.env.PASEO_MAX_HOME || path.join(os.homedir(), ".paseo-max"),
  PASEO_LISTEN: process.env.PASEO_MAX_LISTEN || "127.0.0.1:17678",
  PASEO_ELECTRON_USER_DATA_DIR:
    process.env.PASEO_MAX_USER_DATA || path.join(app.getPath("appData"), "Paseo Max"),
  PASEO_TEST_APP_NAME: "Paseo Max",
};

export function applyForkEnvironment(): void {
  if (isPaseoMax) Object.assign(process.env, forkEnvironment);
}

applyForkEnvironment();
