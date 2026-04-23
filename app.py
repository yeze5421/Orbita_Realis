import http.server
import os
import socket
import socketserver
import threading
import webbrowser
from pathlib import Path

DEFAULT_PORT = 8877
ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def find_free_port(start_port: int = DEFAULT_PORT, host: str = "127.0.0.1", max_tries: int = 50) -> int:
    """Try the preferred port first, then scan upward for a free one."""
    for port in range(start_port, start_port + max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise OSError(f"No free port found between {start_port} and {start_port + max_tries - 1}.")


def main() -> None:
    os.chdir(ROOT)
    host = "127.0.0.1"
    port = find_free_port(DEFAULT_PORT, host=host)

    with ReusableTCPServer((host, port), Handler) as httpd:
        url = f"http://{host}:{port}/index.html"
        print(f"Serving at {url}")
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")


if __name__ == "__main__":
    main()
