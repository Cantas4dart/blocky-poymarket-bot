import * as fs from "fs";
import * as path from "path";

type ReleaseFn = () => void;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function readExistingPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function acquireProcessLock(lockName: string): ReleaseFn | null {
  const lockDir = path.join(__dirname, "../data/locks");
  fs.mkdirSync(lockDir, { recursive: true });

  const safeName = lockName.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  const lockPath = path.join(lockDir, `${safeName}.lock`);

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${process.pid}\n`, "utf-8");
    fs.closeSync(fd);
  } catch (e: any) {
    if (e?.code !== "EEXIST") {
      throw e;
    }

    const existingPid = readExistingPid(lockPath);
    if (existingPid && isProcessAlive(existingPid)) {
      console.error(
        `[LOCK] ${lockName} is already running under PID ${existingPid}. ` +
        `This duplicate instance will exit.`
      );
      return null;
    }

    try {
      fs.unlinkSync(lockPath);
    } catch {
      console.error(`[LOCK] Could not remove stale lock for ${lockName} at ${lockPath}.`);
      return null;
    }

    return acquireProcessLock(lockName);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Best-effort cleanup during shutdown.
    }
  };

  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    release();
    throw err;
  });

  return release;
}
