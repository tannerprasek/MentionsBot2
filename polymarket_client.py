"""
Polymarket API client for fetching mentions markets
"""
import requests
from typing import List, Dict, Optional


class PolymarketClient:
    """Client for interacting with Polymarket API"""

    BASE_URL = "https://gamma-api.polymarket.com"
    CLOB_API = "https://clob.polymarket.com"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })

    def search_markets(self, query: str, limit: int = 50) -> List[Dict]:
        """Search for markets matching a query"""
        try:
            url = f"{self.BASE_URL}/markets"
            params = {
                'limit': limit,
                'offset': 0,
                'closed': 'false'
            }
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()

            markets = response.json()
            # Filter markets that contain the query term
            filtered = [m for m in markets if query.lower() in m.get('question', '').lower()]
            return filtered

        except Exception as e:
            print(f"Error searching markets: {e}")
            return []

    def get_mentions_markets(self, ticker: str = None) -> List[Dict]:
        """
        Get markets related to mentions
        If ticker is provided, filter for that specific ticker
        """
        try:
            url = f"{self.BASE_URL}/markets"
            params = {
                'limit': 100,
                'offset': 0,
                'closed': 'false'
            }
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()

            markets = response.json()

            # Filter for mentions markets
            mentions_keywords = ['mention', 'mentioned', 'say', 'discuss']
            mentions_markets = []

            for market in markets:
                question = market.get('question', '').lower()
                if any(keyword in question for keyword in mentions_keywords):
                    if ticker is None or ticker.lower() in question:
                        mentions_markets.append(market)

            return mentions_markets

        except Exception as e:
            print(f"Error fetching mentions markets: {e}")
            return []

    def get_market_prices(self, market_id: str) -> Optional[Dict]:
        """Get current prices for a market"""
        try:
            url = f"{self.CLOB_API}/prices/{market_id}"
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error fetching market prices: {e}")
            return None

    def format_market_info(self, market: Dict) -> str:
        """Format market information for display"""
        question = market.get('question', 'N/A')
        market_id = market.get('id', 'N/A')
        tokens = market.get('tokens', [])

        info = f"\nMarket: {question}\n"
        info += f"ID: {market_id}\n"

        if tokens:
            for token in tokens:
                outcome = token.get('outcome', 'Unknown')
                price = token.get('price', 'N/A')
                info += f"  {outcome}: {price}\n"

        return info


if __name__ == "__main__":
    # Test the client
    client = PolymarketClient()
    print("Fetching mentions markets...")
    markets = client.get_mentions_markets()
    print(f"Found {len(markets)} mentions markets")
    for market in markets[:3]:
        print(client.format_market_info(market))
