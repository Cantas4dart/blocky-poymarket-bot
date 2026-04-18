import requests
from datetime import datetime

class MarketClient:
    def __init__(self):
        self.gamma_api_url = "https://gamma-api.polymarket.com"

    def get_weather_markets(self):
        """Fetch active weather/temperature markets from Gamma API"""
        try:
            # Search for markets related to weather/temperature
            url = f"{self.gamma_api_url}/markets"
            params = {
                "active": "true",
                "closed": "false",
                "search": "temperature",
                "limit": 100
            }
            res = requests.get(url, params=params)
            res.raise_for_status()
            markets = res.json()
            
            # Additional search for 'weather'
            params["search"] = "weather"
            res = requests.get(url, params=params)
            res.raise_for_status()
            markets.extend(res.json())
            
            # Filter unique markets
            unique_markets = {m["id"]: m for m in markets}.values()
            return list(unique_markets)
        except Exception as e:
            print(f"Error fetching markets: {e}")
            return []

    def parse_market_location(self, market_description):
        """Precise mapping of cities to their settlement stations coordinates"""
        locations = {
            # US Markets
            "New York": (40.7128, -74.0060, True),
            "NYC": (40.7128, -74.0060, True),
            "Chicago": (41.8781, -87.6298, True),
            "Washington": (38.9072, -77.0369, True),
            "Los Angeles": (34.0522, -118.2437, True),
            "Miami": (25.7617, -80.1918, True),
            "Phoenix": (33.4484, -112.0740, True),
            "Dallas": (32.7767, -96.7970, True),
            "Houston": (29.7604, -95.3698, True),
            "Denver": (39.7392, -104.9903, True),
            
            # International Markets
            "London": (51.5074, -0.1278, False), # Heathrow (LHR)
            "Paris": (48.8566, 2.3522, False),   # CDG/Orly
            "Tokyo": (35.6762, 139.6503, False), # Haneda
            "Amsterdam": (52.3676, 4.9041, False),# Schiphol
            "Hong Kong": (22.3193, 114.1694, False),
            "Singapore": (1.3521, 103.8198, False),
            "Sydney": (-33.8688, 151.2093, False),
            "Berlin": (52.5200, 13.4050, False),
            "Toronto": (43.6532, -79.3832, False),
        }
        for loc, coords in locations.items():
            if loc.lower() in market_description.lower():
                return coords
        return None

if __name__ == "__main__":
    client = MarketClient()
    # print(client.get_weather_markets())
