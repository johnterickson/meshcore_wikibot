import json
import shutil
import subprocess
import sys
import urllib.parse
import zipfile
from pathlib import Path

TAG = "prism-b10709-9a9394a"
ROOT = Path(r"D:\prism-bonsai") / TAG
DOWNLOADS = ROOT / "downloads"
CUDA = ROOT / "cuda"
CPU = ROOT / "cpu"
BASE_URL = f"https://github.com/PrismML-Eng/llama.cpp/releases/download/{TAG}"
ASSETS = {
    f"llama-{TAG}-bin-win-cuda-12.4-x64.zip": CUDA,
    "cudart-llama-bin-win-cuda-12.4-x64.zip": CUDA,
    f"llama-{TAG}-bin-win-cpu-x64.zip": CPU,
}


def valid_zip(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as archive:
            return archive.testzip() is None
    except (OSError, zipfile.BadZipFile):
        return False


def download(name: str) -> Path:
    path = DOWNLOADS / name
    if path.exists() and valid_zip(path):
        print(f"Using verified archive: {path} ({path.stat().st_size} bytes)")
        return path
    path.unlink(missing_ok=True)
    url = f"{BASE_URL}/{urllib.parse.quote(name)}"
    print(f"Downloading {url}")
    subprocess.run(
        ["curl.exe", "--fail", "--location", "--output", str(path), url],
        check=True,
    )
    if not valid_zip(path):
        raise RuntimeError(f"Downloaded archive failed validation: {path}")
    print(f"Verified archive: {path} ({path.stat().st_size} bytes)")
    return path


def run(executable: Path, *arguments: str) -> None:
    try:
        result = subprocess.run(
            [str(executable), *arguments],
            cwd=executable.parent,
            capture_output=True,
            text=True,
            timeout=60,
        )
        print(json.dumps({
            "argv": [str(executable), *arguments],
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }, indent=2))
    except Exception as error:
        print(json.dumps({
            "argv": [str(executable), *arguments],
            "error": repr(error),
        }, indent=2))


def main() -> None:
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    CUDA.mkdir(parents=True, exist_ok=True)
    CPU.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(ROOT.drive + "\\")
    print(f"Free space before extraction: {usage.free} bytes")

    for name, destination in ASSETS.items():
        archive_path = download(name)
        print(f"Extracting {archive_path} to {destination}")
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(destination)

    cuda_cli = next(CUDA.rglob("llama-cli.exe"))
    cpu_cli = next(CPU.rglob("llama-cli.exe"))
    run(cuda_cli, "--version")
    run(cuda_cli, "--list-devices")
    run(cpu_cli, "--version")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error!r}", file=sys.stderr)
        raise
