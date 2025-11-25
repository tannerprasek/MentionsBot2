"""
Polymarket API client for fetching mentions markets
Uses the official Gamma Markets API
"""
import requests
import time
from typing import List, Dict, Optional
from datetime import datetime


class PolymarketClient:
    """Client for interacting with Polymarket Gamma Markets API"""

    GAMMA_API = "https://gamma-api.polymarket.com"
    CLOB_API = "https://clob.polymarket.com"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })

    def search_markets(self, query: str, limit: int = 100, closed: bool = False) -> List[Dict]:
        """
        Search for markets matching a query

        Args:
            query: Search term to filter market questions
            limit: Maximum number of results
            closed: Include closed markets (default: False)
        """
        try:
            url = f"{self.GAMMA_API}/markets"
            params = {
                'limit': limit,
                'offset': 0
            }
            response = self.session.get(url, params=params, timeout=15)
            response.raise_for_status()

            markets = response.json()

            # Filter markets that contain the query term and match closed status
            filtered = []
            for m in markets:
                if query.lower() in m.get('question', '').lower():
                    # Filter by closed status if specified
                    if not closed and m.get('closed'):
                        continue
                    filtered.append(m)

            return filtered

        except Exception as e:
            print(f"Error searching markets: {e}")
            return []

    def get_mentions_markets(self, ticker: str = None, limit: int = 100) -> List[Dict]:
        """
        Get markets related to mentions

        Args:
            ticker: Optional ticker to filter for specific company
            limit: Maximum number of markets to fetch
        """
        try:
            url = f"{self.GAMMA_API}/markets"

            # Fetch markets in smaller batches to avoid API issues
            markets = []
            batch_size = 20
            offset = 0

            while len(markets) < limit:
                params = {
                    'limit': min(batch_size, limit - len(markets)),
                    'offset': offset
                }

                response = self.session.get(url, params=params, timeout=15)
                response.raise_for_status()

                batch = response.json()
                if not batch:
                    break

                markets.extend(batch)
                offset += len(batch)

                # Stop if we got fewer results than requested (end of data)
                if len(batch) < batch_size:
                    break

                # Small delay to avoid rate limiting
                time.sleep(0.1)

            # Filter for mentions markets
            mentions_keywords = ['mention', 'mentioned', 'say', 'discuss', 'tweet', 'post',
                               'talk about', 'speak', 'call', 'earnings']
            mentions_markets = []

            for market in markets:
                # Skip closed markets
                if market.get('closed', False):
                    continue

                question = market.get('question', '').lower()
                description = market.get('description', '').lower()

                # Check if it's a mentions-related market
                is_mentions = any(keyword in question or keyword in description
                                 for keyword in mentions_keywords)

                if is_mentions:
                    # If ticker specified, only include markets mentioning that ticker
                    if ticker is None:
                        mentions_markets.append(market)
                    else:
                        ticker_lower = ticker.lower()
                        if ticker_lower in question or ticker_lower in description:
                            mentions_markets.append(market)

            return mentions_markets

        except Exception as e:
            print(f"Error fetching mentions markets: {e}")
            return []

    def get_earnings_events(self, ticker: str = None, limit: int = 100) -> List[Dict]:
        """
        Get earnings call events from Polymarket
        These are events with format: "What will [Company] say during their next earnings call?"

        Args:
            ticker: Optional ticker/company name to filter for
            limit: Maximum number of events to fetch

        Returns:
            List of event dicts, each containing multiple sub-markets
        """
        try:
            url = f"{self.GAMMA_API}/events"

            # Fetch events in batches
            events = []
            batch_size = 50
            offset = 0

            while len(events) < limit:
                params = {
                    'limit': min(batch_size, limit - len(events)),
                    'offset': offset,
                    'closed': 'false'
                }

                response = self.session.get(url, params=params, timeout=15)
                response.raise_for_status()

                batch = response.json()
                if not batch:
                    break

                events.extend(batch)
                offset += len(batch)

                if len(batch) < batch_size:
                    break

                time.sleep(0.15)

            # Filter for earnings call events
            earnings_patterns = ['earnings call', 'say during their next', 'earnings']
            earnings_events = []

            for event in events:
                title = event.get('title', '').lower()

                # Check if it's an earnings event
                is_earnings = any(pattern in title for pattern in earnings_patterns)

                if is_earnings:
                    # If ticker specified, only include events mentioning that ticker
                    if ticker is None:
                        earnings_events.append(event)
                    else:
                        ticker_variations = [
                            ticker.lower(),
                            ticker.upper(),
                            f'({ticker.lower()})',
                            f'({ticker.upper()})'
                        ]
                        if any(var in title for var in ticker_variations):
                            earnings_events.append(event)

            return earnings_events

        except Exception as e:
            print(f"Error fetching earnings events: {e}")
            return []

    def get_event_by_slug(self, slug: str) -> Optional[Dict]:
        """
        Get a specific event by its slug

        Args:
            slug: Event slug from URL (e.g., 'what-will-dell-say-during-their-next-earnings-call')

        Returns:
            Event dict with nested markets, or None if not found
        """
        try:
            url = f"{self.GAMMA_API}/events/slug/{slug}"
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error fetching event {slug}: {e}")
            return None

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

    def get_market_by_id(self, market_id: str) -> Optional[Dict]:
        """Get a specific market by ID"""
        try:
            url = f"{self.GAMMA_API}/markets/{market_id}"
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error fetching market {market_id}: {e}")
            return None

    def format_market_info(self, market: Dict) -> str:
        """Format market information for display"""
        question = market.get('question', 'N/A')
        market_id = market.get('id', 'N/A')

        info = f"\nMarket: {question}\n"
        info += f"ID: {market_id}\n"

        # Get outcome prices from the Gamma API response
        outcomes = market.get('outcomes', [])
        outcome_prices = market.get('outcomePrices', [])

        if outcomes and outcome_prices:
            try:
                # outcomePrices is typically a string that needs parsing
                if isinstance(outcome_prices, str):
                    import json
                    prices = json.loads(outcome_prices)
                else:
                    prices = outcome_prices

                if isinstance(outcomes, str):
                    outcomes_list = json.loads(outcomes)
                else:
                    outcomes_list = outcomes

                for i, outcome in enumerate(outcomes_list):
                    price = prices[i] if i < len(prices) else 'N/A'
                    if isinstance(price, (int, float)):
                        info += f"  {outcome}: {price:.2%}\n"
                    else:
                        info += f"  {outcome}: {price}\n"
            except Exception as e:
                # Fallback if parsing fails
                info += f"  Outcomes: {outcomes}\n"
                info += f"  Prices: {outcome_prices}\n"

        # Add volume and liquidity if available
        volume = market.get('volume', 0)
        liquidity = market.get('liquidity', 0)
        if volume:
            info += f"Volume: ${volume:,.0f}\n"
        if liquidity:
            info += f"Liquidity: ${liquidity:,.0f}\n"

        return info

    def format_event_info(self, event: Dict, show_all_markets: bool = False) -> str:
        """
        Format earnings event information for display

        Args:
            event: Event dict from Gamma API
            show_all_markets: Show all sub-markets or just summary

        Returns:
            Formatted string
        """
        title = event.get('title', 'N/A')
        event_id = event.get('id', 'N/A')
        slug = event.get('slug', 'N/A')
        volume = event.get('volume', 0)
        closed = event.get('closed', False)
        markets = event.get('markets', [])

        info = f"\nEvent: {title}\n"
        info += f"ID: {event_id}\n"
        info += f"Slug: {slug}\n"
        info += f"Status: {'Closed' if closed else 'Open'}\n"
        info += f"Sub-markets: {len(markets)}\n"
        info += f"Total Volume: ${volume:,.0f}\n"

        if show_all_markets and markets:
            info += "\nSub-markets:\n"
            for i, market in enumerate(markets[:20], 1):  # Show first 20
                question = market.get('question', 'N/A')
                prices = market.get('outcomePrices', [])

                # Parse prices if needed
                if isinstance(prices, str):
                    import json
                    try:
                        prices = json.loads(prices)
                    except:
                        prices = []

                yes_price = prices[0] if len(prices) > 0 else 'N/A'
                if isinstance(yes_price, (int, float)):
                    info += f"  {i}. {question}: {yes_price:.2%}\n"
                else:
                    info += f"  {i}. {question}: {yes_price}\n"

            if len(markets) > 20:
                info += f"  ... and {len(markets) - 20} more\n"

        return info


if __name__ == "__main__":
    # Test the client
    client = PolymarketClient()
    print("Fetching mentions markets...")
    markets = client.get_mentions_markets()
    print(f"Found {len(markets)} mentions markets")
    for market in markets[:3]:
        print(client.format_market_info(market))
