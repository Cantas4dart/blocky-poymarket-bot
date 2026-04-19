import json
import os
import re
from datetime import datetime
from .weather import WeatherClient
from .markets import MarketClient
from .model import TradingModel

class SignalGenerator:
    def __init__(self, data_path="../data/signals.json"):
        self.weather = WeatherClient()
        self.markets = MarketClient()
        self.model = TradingModel()
        self.data_path = os.path.join(os.path.dirname(__file__), data_path)

    def run(self):
        print("Starting calibrated signal generation...")
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
                target = self.extract_target(market["question"])
                if not target:
                    continue

                forecast_data = self.extract_predicted_temps(forecast, is_us)
                
                # Use Calibrated Ensemble logic
                avg_prob, conviction = self.model.calculate_ensemble_probability(forecast_data, target)
                
                # Market price for 'Yes'
                raw_prices = market["outcomePrices"]
                if isinstance(raw_prices, str):
                    import json as py_json
                    raw_prices = py_json.loads(raw_prices)
                
                market_price = float(raw_prices[0])
                edge = self.model.get_edge(avg_prob, market_price)
                
                if self.model.should_trade(edge, avg_prob, conviction):
                    signals.append({
                        "market_id": market["id"],
                        "question": market["question"],
                        "target": target,
                        "avg_model_prob": f"{avg_prob:.2%}",
                        "market_price": f"{market_price:.2f}",
                        "edge": f"{edge:.2%}",
                        "action": "BUY_YES" if edge > 0 else "BUY_NO",
                        "timestamp": str(datetime.now())
                    })
            except Exception as e:
                print(f"Error processing market {market['id']}: {e}")

        self.save_signals(signals)
        print(f"Generated {len(signals)} calibrated signals.")

    def extract_target(self, question):
        """
        Extracts target threshold or range from question.
        Standardizes into: 
        - {"type": "threshold", "val": X}
        - {"type": "range", "low": X, "high": Y}
        - {"type": "exact", "val": X}
        """
        # 1. Range Pattern (e.g. 78-79 or between 60 and 61)
        # Matches: "78-79", "60 to 61", "between 60 and 61"
        range_match = re.search(r'(\d+)\s*(?:-|to|and)\s*(\d+)', question)
        if range_match:
            return {
                "type": "range",
                "low": float(range_match.group(1)),
                "high": float(range_match.group(2))
            }
        
        # 2. Exact Pattern (e.g. exactly 7, be 7C)
        # Matches: "exactly 7", "be 7", "at 7"
        exact_match = re.search(r'(?:exactly|be|at)\s*(\d+)', question, re.IGNORECASE)
        # Also handles "be 7C"
        if exact_match:
            return {
                "type": "exact",
                "val": float(exact_match.group(1))
            }

        # 3. Simple Threshold (Default)
        # Matches: "above 80", "over 80", or just plain "80"
        threshold_match = re.search(r'(\d+)', question)
        if threshold_match:
            return {
                "type": "threshold",
                "val": float(threshold_match.group(1))
            }

        return None

    def extract_predicted_temps(self, forecast, is_us):
        if is_us:
            # NOAA single model
            return {"noaa": float(forecast[0]["temperature"])}
        else:
            # Open-Meteo multi-model
            # Note: Using the specific model keys from the API
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