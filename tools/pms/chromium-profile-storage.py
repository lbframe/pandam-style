#!/usr/bin/env python3
"""Run the qualified Chromium executable with an owned, accessible profile.

Only profile storage changes. Browser flags, protocol, assertions and timeouts
are supplied unchanged by the calling qualification harness.
"""

import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile


def main():
    arguments = list(sys.argv[1:])
    profile = None
    child = None
    try:
        for index, argument in enumerate(arguments):
            if not argument.startswith("--user-data-dir="):
                continue
            if profile is not None:
                raise RuntimeError("Multiple browser profile arguments")
            root = pathlib.Path(
                os.environ.get(
                    "PMS_NEXT_CHROMIUM_PROFILE_ROOT",
                    str(pathlib.Path.home() / "snap/chromium/common/pms-checkpoint-browser-profiles"),
                )
            )
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
            profile = pathlib.Path(tempfile.mkdtemp(prefix="qualification-", dir=root))
            arguments[index] = "--user-data-dir=" + str(profile)

        executable = os.environ.get("PMS_NEXT_CHROMIUM_EXECUTABLE", "/usr/local/bin/chromium")
        child = subprocess.Popen([executable, *arguments])

        def forward(signum, _frame):
            if child.poll() is None:
                try:
                    child.send_signal(signum)
                except ProcessLookupError:
                    pass

        signal.signal(signal.SIGTERM, forward)
        signal.signal(signal.SIGINT, forward)
        status = child.wait()
        return status if status >= 0 else 128 - status
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait()
        if profile is not None:
            shutil.rmtree(profile)


if __name__ == "__main__":
    sys.exit(main())
