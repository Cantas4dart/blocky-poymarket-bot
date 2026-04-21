import requests
import re
import time
from requests.adapters import HTTPAdapter
from requests.exceptions import RequestException, SSLError
from urllib3.util.retry import Retry

class MarketClient:
    def __init__(self):
        self.gamma_api_url = "https://gamma-api.polymarket.com"
        self.events_api_url = f"{self.gamma_api_url}/events"
        self.markets_api_url = f"{self.gamma_api_url}/markets"
        self.tags_api_url = f"{self.gamma_api_url}/tags"
        self.geocode_cache = {}  # Cache geocoding results to avoid repeated API calls
        self.tag_id_cache = {}
        self.session = self._build_session()

        # This bot is intentionally temperature-only, not a general weather-market bot.
        self.temperature_keywords = [
            "highest temperature",
            "lowest temperature",
            "temperature",
            "degrees",
            "celsius",
            "fahrenheit",
            "high temp",
            "low temp",
        ]
        self.search_terms = [
            "temperature",
            "highest temperature",
            "lowest temperature",
        ]
        self.temperature_tag_keywords = [
            "temperature",
            "high temp",
            "high-temp",
            "low temp",
            "low-temp",
        ]
        self.weather_tag_keywords = [
            "weather",
            "climate",
        ]

    def _build_session(self):
        session = requests.Session()
        retry = Retry(
            total=3,
            connect=3,
            read=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"],
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        return session

    def get_weather_markets(self):
        """
        Fetch active city daily temperature ladder markets from Gamma API.

        Uses both tag/event discovery and direct keyword search so terminal
        results line up more closely with Polymarket's site search.
        """
        active_events = self._fetch_active_events()
        tagged_events = self._fetch_tagged_events()
        search_markets = self._fetch_search_markets()
        if not active_events and not search_markets:
            print("[MARKETS] WARNING: No active events or search markets returned from Gamma API.")
            return []

        unique_markets = {}
        reviewed_markets = 0

        combined_events = {}
        for event in active_events + tagged_events:
            event_id = event.get("id")
            if event_id is None:
                continue
            combined_events[event_id] = event

        for event in combined_events.values():
            for market in event.get("markets", []):
                reviewed_markets += 1

                if not self._is_tradeable_market(market):
                    continue

                if not self._is_temperature_market(market, event):
                    continue

                market_id = market.get("id")
                if not market_id:
                    continue

                market["_display_question"] = self._market_display_name(market, event)
                unique_markets[market_id] = market

        for market in search_markets:
            reviewed_markets += 1

            if not self._is_tradeable_market(market):
                continue

            if not self._is_temperature_market(market, None):
                continue

            market_id = market.get("id")
            if not market_id:
                continue

            market["_display_question"] = self._market_display_name(market)
            unique_markets[market_id] = market

        temperature_markets = list(unique_markets.values())
        print(f"[MARKETS] Reviewed {reviewed_markets} candidate markets across {len(combined_events)} events and {len(search_markets)} search hits.")
        print(f"[MARKETS] Final active city temperature rung markets: {len(temperature_markets)}")

        if len(temperature_markets) == 0:
            print("[MARKETS] WARNING: No active city temperature ladders found on Polymarket right now.")

        return temperature_markets

    def _fetch_active_events(self, page_limit=100, max_pages=20):
        """Fetch active events with pagination, following Polymarket's recommended discovery flow."""
        events = []
        offset = 0

        for page in range(max_pages):
            try:
                params = {
                    "active": "true",
                    "closed": "false",
                    "order": "volume_24hr",
                    "ascending": "false",
                    "limit": page_limit,
                    "offset": offset,
                }
                batch = self._get_json(self.events_api_url, params=params, timeout=20, label=f"Events page {page + 1}")
                if not isinstance(batch, list):
                    print("[MARKETS] Unexpected events payload from Gamma API.")
                    break

                print(f"[MARKETS] Events page {page + 1} -> {len(batch)} events")
                if len(batch) == 0:
                    break

                events.extend(batch)
                if len(batch) < page_limit:
                    break

                offset += page_limit
            except Exception as e:
                print(f"[MARKETS] Events page {page + 1} FAILED: {e}")
                break

        return events

    def _fetch_tagged_events(self, page_limit=100):
        """Fetch events by Polymarket weather/temperature tags so category discovery is explicit."""
        events = []
        for slug in ("temperature", "weather"):
            tag_id = self._get_tag_id(slug)
            if not tag_id:
                continue

            try:
                params = {
                    "tag_id": tag_id,
                    "related_tags": "true",
                    "active": "true",
                    "closed": "false",
                    "limit": page_limit,
                    "offset": 0,
                }
                batch = self._get_json(self.events_api_url, params=params, timeout=20, label=f"Tag events '{slug}'")
                if not isinstance(batch, list):
                    print(f"[MARKETS] Tag events '{slug}' returned an unexpected payload.")
                    continue

                print(f"[MARKETS] Tag events '{slug}' -> {len(batch)} events")
                events.extend(batch)
            except Exception as e:
                print(f"[MARKETS] Tag events '{slug}' FAILED: {e}")

        return events

    def _fetch_search_markets(self, limit_per_term=100):
        """Fallback discovery path using the same search-style terms that surface markets on the site."""
        markets = []

        for term in self.search_terms:
            try:
                params = {
                    "active": "true",
                    "closed": "false",
                    "limit": limit_per_term,
                    "search": term,
                }
                batch = self._get_json(self.markets_api_url, params=params, timeout=20, label=f"Search '{term}'")
                if not isinstance(batch, list):
                    print(f"[MARKETS] Search '{term}' returned an unexpected payload.")
                    continue

                print(f"[MARKETS] Search '{term}' -> {len(batch)} raw markets")
                markets.extend(batch)
            except Exception as e:
                print(f"[MARKETS] Search '{term}' FAILED: {e}")

        return markets

    def _get_tag_id(self, slug):
        if slug in self.tag_id_cache:
            return self.tag_id_cache[slug]

        try:
            tag = self._get_json(f"{self.tags_api_url}/slug/{slug}", timeout=20, label=f"Tag '{slug}'")
            tag_id = tag.get("id") if isinstance(tag, dict) else None
            if tag_id:
                self.tag_id_cache[slug] = tag_id
                print(f"[MARKETS] Tag '{slug}' -> id {tag_id}")
                return tag_id
        except Exception as e:
            print(f"[MARKETS] Tag '{slug}' lookup FAILED: {e}")

        self.tag_id_cache[slug] = None
        return None

    def _get_json(self, url, params=None, timeout=20, label="request", attempts=3):
        last_error = None
        for attempt in range(1, attempts + 1):
            try:
                res = self.session.get(url, params=params, timeout=timeout)
                res.raise_for_status()
                return res.json()
            except SSLError as e:
                last_error = e
                if attempt < attempts:
                    print(f"[MARKETS] {label} SSL error on attempt {attempt}/{attempts}; retrying...")
                    time.sleep(attempt)
                    continue
                raise
            except RequestException as e:
                last_error = e
                if attempt < attempts:
                    print(f"[MARKETS] {label} request error on attempt {attempt}/{attempts}; retrying...")
                    time.sleep(attempt)
                    continue
                raise
            except ValueError as e:
                last_error = e
                raise

        if last_error:
            raise last_error

    def _is_tradeable_market(self, market):
        """Only consider live, order-book-enabled markets that can actually be traded."""
        if not market.get("active", False):
            return False
        if market.get("closed", True):
            return False
        if not market.get("enableOrderBook", False):
            return False

        accepting_orders = market.get("acceptingOrders")
        if accepting_orders is False:
            return False

        return True

    def _is_temperature_market(self, market, event=None):
        """Restrict discovery to city/day highest-temperature ladder rungs only."""
        question = market.get("question", "").lower()
        title = market.get("title", "").lower()
        group_item_title = market.get("groupItemTitle", "").lower()
        description = market.get("description", "").lower()
        slug = market.get("slug", "").lower()
        event_title = event.get("title", "").lower() if event else market.get("eventTitle", "").lower()
        event_slug = event.get("slug", "").lower() if event else market.get("eventSlug", "").lower()
        event_tag_text = self._extract_tag_text(event.get("tags", [])) if event else ""
        market_tag_text = self._extract_tag_text(market.get("tags", []))
        tag_text = " ".join([event_tag_text, market_tag_text]).strip()

        text_blob = " ".join([question, title, group_item_title, description, slug, event_title, event_slug, tag_text])
        has_temperature_keyword = any(keyword in text_blob for keyword in self.temperature_keywords)
        has_temperature_tag = any(keyword in tag_text for keyword in self.temperature_tag_keywords)
        has_weather_tag = any(keyword in tag_text for keyword in self.weather_tag_keywords)
        ladder_context = " ".join([event_title, title, group_item_title]).strip()
        has_city_temperature_event = bool(
            re.search(r'\bhighest temperature in .+ on [a-z]+ \d{1,2}\b', ladder_context)
        )
        looks_like_temperature_rung = bool(
            re.search(r'\bwill the highest temperature in\b', question)
            and re.search(r'\bon [a-z]+ \d{1,2}\b', question)
            and re.search(r'(?:between|or below|or higher|\d+(?:\.\d+)?\s*(?:°\s*)?(?:f|c))', question)
        )

        is_temperature = (
            has_city_temperature_event
            and looks_like_temperature_rung
            and has_temperature_keyword
            and (has_temperature_tag or has_weather_tag)
        )

        if is_temperature:
            print(f"[MARKETS]   [OK] KEPT: {self._market_display_name(market, event)[:120]}")

        return is_temperature

    def _extract_tag_text(self, tags):
        return " ".join(
            f"{tag.get('label', '')} {tag.get('slug', '')}".lower()
            for tag in tags
            if isinstance(tag, dict)
        )

    def _market_display_name(self, market, event=None):
        event_title = ""
        if event:
            event_title = event.get("title", "") or event.get("slug", "")
        if not event_title:
            event_title = market.get("eventTitle", "") or market.get("title", "") or market.get("groupItemTitle", "")

        question = market.get("question", "") or market.get("slug", "")
        if event_title and question and question.lower() != event_title.lower():
            return f"{event_title} :: {question}"
        return event_title or question or "Unknown market"

    def parse_market_location(self, market_description):
        """
        Resolve a city from market question to (lat, lon, is_us) coordinates.

        Strategy:
        1. Check the hardcoded dictionary first (fastest, most reliable).
        2. If no match, attempt to extract a city name and geocode it via
           Open-Meteo's free geocoding API (no API key needed).
        3. Cache geocoding results to avoid repeated API calls.
        """

        # --- Step 1: Hardcoded high-priority locations ---
        locations = {
            # US Markets (is_us=True -> uses NOAA forecast)
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
            "Atlanta": (33.7490, -84.3880, True),
            "Seattle": (47.6062, -122.3321, True),
            "San Francisco": (37.7749, -122.4194, True),
            "Boston": (42.3601, -71.0589, True),

            # International Markets (is_us=False -> uses Open-Meteo multi-model)
            "London": (51.5074, -0.1278, False),
            "Paris": (48.8566, 2.3522, False),
            "Tokyo": (35.6762, 139.6503, False),
            "Amsterdam": (52.3676, 4.9041, False),
            "Hong Kong": (22.3193, 114.1694, False),
            "Singapore": (1.3521, 103.8198, False),
            "Sydney": (-33.8688, 151.2093, False),
            "Berlin": (52.5200, 13.4050, False),
            "Toronto": (43.6532, -79.3832, False),
            "Dubai": (25.2048, 55.2708, False),
            "Mumbai": (19.0760, 72.8777, False),
            "Delhi": (28.6139, 77.2090, False),
            "Beijing": (39.9042, 116.4074, False),
            "Seoul": (37.5665, 126.9780, False),
            "Madrid": (40.4168, -3.7038, False),
            "Rome": (41.9028, 12.4964, False),
            "Taipei": (25.0330, 121.5654, False),
            "Shenzhen": (22.5431, 114.0579, False),
            "Wuhan": (30.5928, 114.3055, False),
            "Sao Paulo": (-23.5505, -46.6333, False),
            "Istanbul": (41.0082, 28.9784, False),
            "Shanghai": (31.2304, 121.4737, False),
            "Chongqing": (29.4316, 106.9123, False),
            "Helsinki": (60.1699, 24.9384, False),
            "Moscow": (55.7558, 37.6173, False),
            "Bangkok": (13.7563, 100.5018, False),
            "Jakarta": (-6.2088, 106.8456, False),
            "Mexico City": (19.4326, -99.1332, False),
            "Cairo": (30.0444, 31.2357, False),
            "Lagos": (6.5244, 3.3792, False),
            "Buenos Aires": (-34.6037, -58.3816, False),
            "Lima": (-12.0464, -77.0428, False),
            "Bogota": (4.7110, -74.0721, False),
            "Osaka": (34.6937, 135.5023, False),
            "Riyadh": (24.7136, 46.6753, False),
            "Nairobi": (-1.2921, 36.8219, False),
            "Johannesburg": (-26.2041, 28.0473, False),
            "Melbourne": (-37.8136, 144.9631, False),
            "Auckland": (-36.8485, 174.7633, False),
            "Warsaw": (52.2297, 21.0122, False),
            "Lisbon": (38.7223, -9.1393, False),
            "Athens": (37.9838, 23.7275, False),
            "Prague": (50.0755, 14.4378, False),
            "Vienna": (48.2082, 16.3738, False),
            "Stockholm": (59.3293, 18.0686, False),
            "Oslo": (59.9139, 10.7522, False),
            "Copenhagen": (55.6761, 12.5683, False),
            "Zurich": (47.3769, 8.5417, False),
            "Munich": (48.1351, 11.5820, False),
        }

        # Check hardcoded locations first
        for loc, coords in locations.items():
            if loc.lower() in market_description.lower():
                return coords

        # --- Step 2: Dynamic geocoding fallback ---
        return self._geocode_from_question(market_description)

    def _geocode_from_question(self, question):
        """
        Attempt to extract a city/place name from the question and geocode it
        using Open-Meteo's free geocoding API (no key required).

        Returns (lat, lon, is_us) or None if nothing found.
        """
        # Try to extract a capitalized place name from the question
        # Pattern: look for capitalized words that could be city names
        # Common patterns in Polymarket weather questions:
        #   "Will the highest temperature in [City] exceed 80F?"
        #   "Will [City] temperature be above 75 degrees?"
        city_patterns = [
            r'(?:in|for|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)',  # "in New York"
            r'(?:Will|will)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:temperature|temp|high|low|weather)',
            r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:temperature|temp|high|low|forecast|weather)',
        ]

        candidates = []
        for pattern in city_patterns:
            matches = re.findall(pattern, question)
            candidates.extend(matches)

        # Filter out common non-city words
        skip_words = {
            "Will", "The", "What", "How", "This", "That", "Yes", "No",
            "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
            "Saturday", "Sunday", "January", "February", "March",
            "April", "May", "June", "July", "August", "September",
            "October", "November", "December", "Today", "Tomorrow",
        }

        for candidate in candidates:
            if candidate in skip_words:
                continue
            if len(candidate) < 3:
                continue

            # Check cache first
            if candidate in self.geocode_cache:
                cached = self.geocode_cache[candidate]
                if cached is not None:
                    print(f"[MARKETS]   [GEOCODE] Cache hit: '{candidate}' -> ({cached[0]}, {cached[1]})")
                    return cached
                continue

            # Query Open-Meteo geocoding API
            result = self._geocode_city(candidate)
            if result:
                self.geocode_cache[candidate] = result
                return result
            else:
                self.geocode_cache[candidate] = None  # Cache misses too

        return None

    def _geocode_city(self, city_name):
        """
        Geocode a city name using Open-Meteo's free geocoding API.
        Returns (lat, lon, is_us) or None.
        """
        try:
            url = "https://geocoding-api.open-meteo.com/v1/search"
            params = {
                "name": city_name,
                "count": 1,
                "language": "en",
                "format": "json"
            }
            res = requests.get(url, params=params, timeout=10)
            res.raise_for_status()
            data = res.json()

            results = data.get("results", [])
            if not results:
                print(f"[MARKETS]   [GEOCODE] No results for '{city_name}'")
                return None

            top = results[0]
            lat = top["latitude"]
            lon = top["longitude"]
            country = top.get("country_code", "").upper()
            is_us = (country == "US")

            print(f"[MARKETS]   [GEOCODE] Resolved '{city_name}' -> ({lat}, {lon}), "
                  f"country={top.get('country', '?')}, is_us={is_us}")
            return (lat, lon, is_us)

        except Exception as e:
            print(f"[MARKETS]   [GEOCODE] Failed for '{city_name}': {e}")
            return None


if __name__ == "__main__":
    client = MarketClient()
    markets = client.get_weather_markets()
    print(f"\n=== Found {len(markets)} weather markets ===")
    for m in markets:
        print(f"  - {m.get('question', '?')}")

    # Test geocoding fallback
    print("\n=== Testing geocoding fallback ===")
    test_questions = [
        "Will the highest temperature in Taipei exceed 35C?",
        "Will Helsinki temperature be above 20 degrees?",
        "Will the high in Reykjavik be over 15C tomorrow?",
        "What will the temperature in Anchorage be?",
    ]
    for q in test_questions:
        result = client.parse_market_location(q)
        print(f"  '{q[:50]}...' -> {result}")
