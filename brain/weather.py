import requests
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

class WeatherClient:
    def __init__(self):
        self.user_agent = {"User-Agent": "(polymarket-weather-bot, contact@example.com)"}

    def get_noaa_forecast(self, lat, lon):
        """Fetch forecast from api.weather.gov (US only)"""
        try:
            points_url = f"https://api.weather.gov/points/{lat},{lon}"
            res = requests.get(points_url, headers=self.user_agent)
            res.raise_for_status()
            forecast_url = res.json()["properties"]["forecastHourly"]
            
            res = requests.get(forecast_url, headers=self.user_agent)
            res.raise_for_status()
            return res.json()["properties"]["periods"]
        except Exception as e:
            print(f"Error fetching NOAA forecast: {e}")
            return None

    def get_open_meteo_forecast(self, lat, lon):
        """Fetch both ECMWF and GFS forecasts from Open-Meteo (Global)"""
        try:
            url = "https://api.open-meteo.com/v1/forecast"
            params = {
                "latitude": lat,
                "longitude": lon,
                "hourly": "temperature_2m",
                "models": "ecmwf_ifs025,gfs_seamless", # Requesting both major models
                "forecast_days": 7
            }
            res = requests.get(url, params=params)
            res.raise_for_status()
            return res.json()["hourly"]
        except Exception as e:
            print(f"Error fetching Open-Meteo forecast: {e}")
            return None

    def get_forecast(self, lat, lon, is_us=True):
        if is_us:
            return self.get_noaa_forecast(lat, lon)
        else:
            return self.get_open_meteo_forecast(lat, lon)

if __name__ == "__main__":
    client = WeatherClient()
    # Test with NYC coordinates
    # print(client.get_forecast(40.7128, -74.0060, is_us=True))
