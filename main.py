#!/usr/bin/env python3
"""
Polymarket Mentions Bot - Main CLI
Scans Polymarket mentions markets and identifies mispricings based on actual transcript data
"""
import sys
import argparse
from polymarket_client import PolymarketClient
from transcript_downloader import TranscriptDownloader
from mentions_analyzer import MentionsAnalyzer


def scan_mentions_markets():
    """Scan and display all available earnings call events on Polymarket"""
    print("\n🔍 Scanning Polymarket for earnings call events...\n")

    client = PolymarketClient()
    events = client.get_earnings_events()

    if not events:
        print("No earnings call events found.")
        print("\nNote: Earnings markets are seasonal and created during earnings season.")
        print("Try again during quarterly earnings periods.")
        return

    print(f"Found {len(events)} earnings call events:\n")
    print("-" * 80)

    for i, event in enumerate(events, 1):
        print(f"\n{i}. {event.get('title', 'N/A')}")
        print(f"   ID: {event.get('id', 'N/A')}")
        print(f"   Slug: {event.get('slug', 'N/A')}")
        print(f"   Sub-markets: {len(event.get('markets', []))}")
        print(f"   Volume: ${event.get('volume', 0):,.0f}")

    print("\n" + "-" * 80)


def analyze_ticker(ticker: str, event_slug: str = None, transcript_file: str = None):
    """
    Analyze a ticker for mispricing opportunities in earnings call events

    Args:
        ticker: Stock ticker symbol (e.g., 'AAPL', 'TSLA')
        event_slug: Optional specific event slug to analyze
        transcript_file: Optional path to transcript text file
    """
    print(f"\n🎯 Analyzing ticker: {ticker.upper()}\n")

    # Initialize components
    client = PolymarketClient()
    downloader = TranscriptDownloader()
    analyzer = MentionsAnalyzer()

    # Step 1: Find relevant earnings events
    print("Step 1: Finding relevant Polymarket earnings events...")
    if event_slug:
        event = client.get_event_by_slug(event_slug)
        events = [event] if event else []
    else:
        events = client.get_earnings_events(ticker)

    if not events:
        print(f"❌ No earnings call events found for {ticker}")
        print("\nNote: These markets are seasonal. Try during quarterly earnings periods.")
        return

    print(f"✓ Found {len(events)} earnings event(s)\n")

    # Step 2: Get transcript text
    if transcript_file:
        print(f"Step 2: Loading transcript from file: {transcript_file}...")
        try:
            with open(transcript_file, 'r', encoding='utf-8') as f:
                all_text = f.read()
            print(f"✓ Loaded transcript ({len(all_text):,} characters)\n")
        except Exception as e:
            print(f"❌ Error loading transcript file: {e}")
            return
    else:
        print("Step 2: Downloading transcripts from public sources...")
        print("⚠️  Note: SEC 8-K filings don't contain full earnings transcripts.")
        print("   For accurate analysis, provide a transcript file with --transcript-file")
        transcripts = downloader.get_recent_transcripts(ticker)

        if not transcripts:
            print(f"❌ No transcripts found for {ticker}")
            print("   Note: Try checking if the ticker symbol is correct")
            print("   or if there are recent SEC filings available.")
            return

        print(f"✓ Downloaded {len(transcripts)} filing(s)\n")

        # Combine all transcript texts for searching
        all_text = '\n'.join([t['text'] for t in transcripts])

    # Step 3: Analyze each event
    print("Step 3: Analyzing for mispricings...\n")

    for event in events:
        print("=" * 80)
        print(f"EVENT: {event.get('title', 'N/A')}")
        print("=" * 80 + "\n")

        markets = event.get('markets', [])
        print(f"Analyzing {len(markets)} sub-markets (phrases)...\n")

        mispricings_found = []

        for market in markets:
            question = market.get('question', '')

            # Extract the quoted phrase from the question
            # Format: 'Will Snowflake say "Repurchase" during earnings call?'
            # Extract: 'Repurchase'
            import re
            quote_match = re.search(r'"([^"]+)"', question)
            if not quote_match:
                # Skip if we can't find a quoted phrase
                continue

            phrase = quote_match.group(1)

            prices = market.get('outcomePrices', [])

            # Parse prices
            if isinstance(prices, str):
                import json
                try:
                    prices = json.loads(prices)
                except:
                    prices = []

            yes_price = float(prices[0]) if len(prices) > 0 else 0.5

            # Count how many times this phrase appears in transcripts
            phrase_count = analyzer.count_mentions(all_text, [phrase], case_sensitive=False)
            total_count = phrase_count.get(phrase.lower() if phrase else phrase, 0)

            # Determine if phrase was mentioned (threshold = 1)
            was_mentioned = total_count > 0

            # Calculate expected price
            expected_price = 0.90 if was_mentioned else 0.10

            # Check for mispricing
            price_diff = abs(yes_price - expected_price)
            is_mispriced = price_diff > 0.20  # 20% threshold

            if is_mispriced:
                opportunity = "BUY_YES" if yes_price < expected_price else "BUY_NO"
                mispricings_found.append({
                    'phrase': phrase,
                    'yes_price': yes_price,
                    'expected_price': expected_price,
                    'was_mentioned': was_mentioned,
                    'count': total_count,
                    'opportunity': opportunity,
                    'price_diff': price_diff
                })

        # Print results
        if mispricings_found:
            print(f"🎯 Found {len(mispricings_found)} potential mispricings:\n")
            for i, mp in enumerate(mispricings_found, 1):
                print(f"{i}. Phrase: \"{mp['phrase']}\"")
                print(f"   Mentioned: {'YES' if mp['was_mentioned'] else 'NO'} ({mp['count']} times)")
                print(f"   Market Price (YES): {mp['yes_price']:.1%}")
                print(f"   Expected: {mp['expected_price']:.0%}")
                print(f"   Difference: {mp['price_diff']:.1%}")
                print(f"   🎯 {mp['opportunity']}")
                print()
        else:
            print("No significant mispricings detected for this event.\n")

        print()


def interactive_mode():
    """Run in interactive mode"""
    print("\n" + "=" * 80)
    print("🤖 Polymarket Mentions Bot - Interactive Mode")
    print("=" * 80)
    print("\nCommands:")
    print("  1. scan    - Scan all mentions markets")
    print("  2. analyze - Analyze a specific ticker")
    print("  3. quit    - Exit")
    print("\n" + "=" * 80 + "\n")

    while True:
        try:
            choice = input("\nEnter command (scan/analyze/quit): ").strip().lower()

            if choice in ['quit', 'q', 'exit']:
                print("\n👋 Goodbye!")
                break

            elif choice in ['scan', 's', '1']:
                scan_mentions_markets()

            elif choice in ['analyze', 'a', '2']:
                ticker = input("Enter ticker symbol: ").strip().upper()
                if ticker:
                    analyze_ticker(ticker)
                else:
                    print("❌ Invalid ticker")

            else:
                print("❌ Invalid command. Use 'scan', 'analyze', or 'quit'")

        except KeyboardInterrupt:
            print("\n\n👋 Goodbye!")
            break
        except Exception as e:
            print(f"\n❌ Error: {e}")


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='Polymarket Mentions Bot - Identify mispricings in earnings call events'
    )
    parser.add_argument(
        '--scan',
        action='store_true',
        help='Scan and display all earnings call events'
    )
    parser.add_argument(
        '--ticker',
        type=str,
        help='Ticker symbol to analyze (e.g., AAPL, TSLA)'
    )
    parser.add_argument(
        '--event-slug',
        type=str,
        help='Specific event slug to analyze (e.g., earnings-mentions-snowflake-2025-11-26)'
    )
    parser.add_argument(
        '--transcript-file',
        type=str,
        help='Path to earnings transcript text file for analysis'
    )
    parser.add_argument(
        '--interactive',
        action='store_true',
        help='Run in interactive mode'
    )

    args = parser.parse_args()

    # If no arguments provided, show help and enter interactive mode
    if len(sys.argv) == 1:
        parser.print_help()
        print("\n" + "=" * 80)
        choice = input("\nWould you like to enter interactive mode? (y/n): ").strip().lower()
        if choice in ['y', 'yes']:
            interactive_mode()
        return

    # Handle command-line arguments
    if args.interactive:
        interactive_mode()
    elif args.scan:
        scan_mentions_markets()
    elif args.ticker:
        analyze_ticker(args.ticker, args.event_slug, args.transcript_file)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
