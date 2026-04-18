import time
from markets import get_weather_markets
from weather import get_forecast
from model import compute_probability
from signals import save_signals

THRESHOLD = 0.1

while True:
    signals = []

    markets = get_weather_markets()

    for m in markets:
        temps = get_forecast(m["lat"], m["lon"])
        prob = compute_probability(temps, m["target"])

        edge = prob - m["price"]

        if edge > THRESHOLD:
            signals.append({
                "id": m["id"],
                "market_id": m["id"],
                "action": "BUY_YES",
                "price": round(m["price"] + 0.01, 2),
                "confidence": edge
            })

    save_signals(signals)
    time.sleep(300)