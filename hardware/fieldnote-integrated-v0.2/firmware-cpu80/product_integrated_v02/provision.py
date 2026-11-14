#!/usr/bin/env python3
"""Provision runtime-only Wi-Fi credentials over the ESP32 USB serial link."""

from __future__ import annotations

import argparse
import getpass
import sys
import time

import serial


def read_line(connection: serial.Serial, deadline: float) -> str | None:
    data = bytearray()
    while time.monotonic() < deadline:
        value = connection.read(1)
        if not value:
            continue
        if value == b"\n":
            return data.decode("utf-8", errors="replace").rstrip("\r")
        data.extend(value)
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="/dev/cu.usbserial-0001")
    parser.add_argument("--ssid", default="IoT")
    args = parser.parse_args()

    password = bytearray(getpass.getpass("Wi-Fi password: ").encode("utf-8"))
    try:
        with serial.Serial(args.port, 115200, timeout=0.2, write_timeout=2) as connection:
            connection.dtr = False
            connection.rts = False

            ready_deadline = time.monotonic() + 25
            while True:
                line = read_line(connection, ready_deadline)
                if line is None:
                    raise RuntimeError("Timed out waiting for the ESP32 Wi-Fi prompt")
                print(line, flush=True)
                if line == "READY_FOR_WIFI":
                    break

            connection.write(args.ssid.encode("utf-8") + b"\n")
            connection.write(password + b"\n")
            connection.flush()

            result_deadline = time.monotonic() + 50
            ip_address = None
            app_ready = False
            while time.monotonic() < result_deadline:
                line = read_line(connection, result_deadline)
                if line is None:
                    break
                print(line, flush=True)
                if line.startswith("IP="):
                    ip_address = line.removeprefix("IP=")
                elif line == "NFC_WEB_READY":
                    app_ready = True
                    break
                elif line.startswith("WIFI_FAILED"):
                    raise RuntimeError(line)

            if not ip_address or not app_ready:
                raise RuntimeError("ESP32 did not report a ready NFC web app")
            print(f"RESULT_IP={ip_address}", flush=True)
            return 0
    finally:
        for index in range(len(password)):
            password[index] = 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
