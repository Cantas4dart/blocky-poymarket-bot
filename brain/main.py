"""
Blocky Polymarket - Brain (Signal Engine)
Runs on a loop, scanning weather markets and generating trade signals.
"""
import time
import sys
import os

# Ensure we can import sibling modules when run directly
sys.path.insert(0, os.path.dirname(__file__))

from markets import MarketClient
from weather import WeatherClient
from model import TradingModel
from signals import SignalGenerator

SCAN_INTERVAL = 300  # 5 minutes

def main():
    print("=" * 50)
    print("  Blocky Brain - Calibrated Signal Engine v2")
    print("=" * 50)

    gen = SignalGenerator()

    while True:
        try:
            print(f"\n[BRAIN] Starting market scan...")
            gen.run()
            print(f"[BRAIN] Scan complete. Sleeping {SCAN_INTERVAL}s...")
        except KeyboardInterrupt:
            print("\n[BRAIN] Shutting down gracefully.")
            break
        except Exception as e:
            print(f"[BRAIN ERROR] {e}")

        time.sleep(SCAN_INTERVAL)

if __name__ == "__main__":
    main()