#!/usr/bin/env bash
# Crash beat: keep the rover brain alive. If it dies, the Arduino watchdog has already stopped the wheels;
# we restart after 2 s and the executor calls Rover.recover() ("Resuming mission, step N of 5").
cd "$(dirname "$0")/.." || exit 1
trap 'echo "[run-rover] bye"; exit 0' INT TERM
while true; do
    echo "[run-rover] starting rover ($(date +%T))"
    npm run rover
    echo "[run-rover] rover exited with $?; restarting in 2 s (Ctrl-C to quit)"
    sleep 2
done
