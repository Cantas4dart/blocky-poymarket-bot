import atexit
import os
import signal
from pathlib import Path
from typing import Callable, Optional


def _is_process_alive(pid: int) -> bool:
    if pid <= 0:
        return False

    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_existing_pid(lock_path: Path) -> Optional[int]:
    try:
        raw = lock_path.read_text(encoding="utf-8").strip()
        return int(raw)
    except (OSError, ValueError):
        return None


def acquire_process_lock(lock_name: str) -> Optional[Callable[[], None]]:
    lock_dir = Path(__file__).resolve().parent.parent / "data" / "locks"
    lock_dir.mkdir(parents=True, exist_ok=True)

    safe_name = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in lock_name).lower()
    lock_path = lock_dir / f"{safe_name}.lock"

    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(f"{os.getpid()}\n")
    except FileExistsError:
        existing_pid = _read_existing_pid(lock_path)
        if existing_pid and _is_process_alive(existing_pid):
            print(
                f"[LOCK] {lock_name} is already running under PID {existing_pid}. "
                "This duplicate instance will exit."
            )
            return None

        try:
            lock_path.unlink()
        except OSError:
            print(f"[LOCK] Could not remove stale lock for {lock_name} at {lock_path}.")
            return None

        return acquire_process_lock(lock_name)

    released = False

    def release() -> None:
        nonlocal released
        if released:
            return
        released = True
        try:
            if lock_path.exists():
                lock_path.unlink()
        except OSError:
            pass

    atexit.register(release)

    def _handle_signal(signum, frame):
        release()
        raise SystemExit(0)

    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            signal.signal(sig, _handle_signal)

    return release
