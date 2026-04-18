import json
import os
from datetime import datetime
from weather import WeatherClient
from markets import MarketClient
from model import TradingModel

class SignalGenerator:
    def __init__(self, data_path="../data/signals.json"):
        self.weather = WeatherClient()
        self.markets = MarketClient()
        self.model = TradingModel()
        self.data_path = os.path.join(os.path.dirname(__file__), data_path)

    def run(self):
        print("Starting global ensemble signal generation...")
        active_markets = self.markets.get_weather_markets()
        print(f"[DEBUG] Found {len(active_markets)} active weather markets on Polymarket.")
        signals = []

        for market in active_markets:
            location = self.markets.parse_market_location(market["question"])
            if not location:
                continue
            
            lat, lon, is_us = location
            forecast = self.weather.get_forecast(lat, lon, is_us)
            
            if not forecast:
                continue

            try:
                threshold = self.extract_threshold(market["question"])
                forecast_data = self.extract_predicted_temps(forecast, is_us)
                
                # Use ensemble logic
                avg_prob, conviction = self.model.calculate_ensemble_probability(forecast_data, threshold)
                
                # Market price for 'Yes'
                raw_prices = market["outcomePrices"]
                if isinstance(raw_prices, str):
                    import json as py_json
                    raw_prices = py_json.loads(raw_prices)
                
                market_price = float(raw_prices[0])
                edge = self.model.get_edge(avg_prob, market_price)
                
                if self.model.should_trade(edge, conviction):
                    signals.append({
                        "market_id": market["id"],
                        "question": market["question"],
                        "avg_model_prob": avg_prob,
                        "conviction": conviction,
                        "market_price": market_price,
                        "edge": edge,
                        "action": "BUY_YES" if edge > 0 else "BUY_NO",
                        "timestamp": str(datetime.now())
                    })
            except Exception as e:
                print(f"Error processing market {market['id']}: {e}")

        self.save_signals(signals)
        print(f"Generated {len(signals)} ensemble signals.")

    def extract_threshold(self, question):
        import re
        # Look for numbers near "degrees" or just numbers at the end
        match = re.search(r'(\d+\.?\d*)\s*(degrees|°F|°C|F|C)?', question)
        if match:
            return float(match.group(1))
        return 0.0

    def extract_predicted_temps(self, forecast, is_us):
        if is_us:
            # NOAA single model
            return {"noaa": float(forecast[0]["temperature"])}
        else:
            # Open-Meteo multi-model
            # Note: Open-Meteo keys often have the model name appended
            return {
                "ecmwf": float(forecast.get("temperature_2m_ecmwf_ifs025", [0])[0]),
                "gfs": float(forecast.get("temperature_2m_gfs_seamless", [0])[0])
            }

    def save_signals(self, signals):
        os.makedirs(os.path.dirname(self.data_path), exist_ok=True)
        with open(self.data_path, 'w') as f:
            json.dump({
                "last_run": str(datetime.now()),
                "signals": signals
            }, f, indent=2)

if __name__ == "__main__":
    gen = SignalGenerator()
    gen.run()