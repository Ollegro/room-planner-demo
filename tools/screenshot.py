"""Headless-скриншот прототипа: поднимает локальный сервер, снимает страницу Edge/Chrome.

Запуск из папки demo_room_generator:
    python tools/screenshot.py
    python tools/screenshot.py --page "" --out docs/screenshot_demo1.png
"""

from __future__ import annotations

import argparse
import http.server
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.request
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BROWSERS = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
)


def find_browser() -> str:
    for candidate in BROWSERS:
        if Path(candidate).exists():
            return candidate
    raise SystemExit("Не найден Edge или Chrome для headless-скриншота")


def start_server(port: int, directory: Path) -> socketserver.TCPServer:
    """port=0 — ОС сама выдаст свободный порт (устойчиво к висящим процессам)."""
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description="Скриншот прототипа в headless-браузере")
    parser.add_argument("--port", type=int, default=0, help="0 — выбрать свободный порт автоматически")
    parser.add_argument("--page", default="", help="путь страницы относительно корня проекта")
    parser.add_argument("--out", default="docs/screenshot_demo1.png")
    parser.add_argument("--width", type=int, default=1500)
    parser.add_argument("--height", type=int, default=950)
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()

    httpd = start_server(args.port, ROOT)
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/{args.page}"
    print(f"server: {url}")
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            print(f"server status: {response.status}")
    finally:
        pass

    browser = find_browser()
    out_path = (ROOT / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.gettempdir()) / "demo-room-generator-profile"

    command = [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--enable-unsafe-swiftshader",
        "--no-sandbox",
        "--no-first-run",
        f"--user-data-dir={profile}",
        f"--window-size={args.width},{args.height}",
        "--virtual-time-budget=10000",
        f"--screenshot={out_path}",
        url,
    ]
    print(f"browser: {browser}")
    result = subprocess.run(command, capture_output=True, timeout=args.timeout)
    print(f"browser exit code: {result.returncode}")
    if result.stderr:
        tail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-5:]
        for line in tail:
            print(f"  browser stderr: {line}")
    print(f"screenshot: {out_path} exists={out_path.exists()} bytes={out_path.stat().st_size if out_path.exists() else 0}")

    httpd.shutdown()
    httpd.server_close()


if __name__ == "__main__":
    main()
