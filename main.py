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
    """Scan and display all available mentions markets on Polymarket"""
    print("\n🔍 Scanning Polymarket for mentions markets...\n")

    client = PolymarketClient()
    markets = client.get_mentions_markets()

    if not markets:
        print("No mentions markets found.")
        return

    print(f"Found {len(markets)} mentions markets:\n")
    print("-" * 80)

    for i, market in enumerate(markets, 1):
        print(f"\n{i}. {market.get('question', 'N/A')}")
        print(f"   ID: {market.get('id', 'N/A')}")

        tokens = market.get('tokens', [])
        if tokens:
            for token in tokens:
                outcome = token.get('outcome', 'Unknown')
                price = token.get('price', 'N/A')
                print(f"   {outcome}: {price}")

    print("\n" + "-" * 80)


def analyze_ticker(ticker: str, market_id: str = None):
    """
    Analyze a ticker for mispricing opportunities

    Args:
        ticker: Stock ticker symbol (e.g., 'AAPL', 'TSLA')
        market_id: Optional specific market ID to analyze
    """
    print(f"\n🎯 Analyzing ticker: {ticker.upper()}\n")

    # Initialize components
    client = PolymarketClient()
    downloader = TranscriptDownloader()
    analyzer = MentionsAnalyzer()

    # Step 1: Find relevant markets
    print("Step 1: Finding relevant Polymarket mentions markets...")
    if market_id:
        # TODO: Add method to fetch specific market by ID
        markets = client.get_mentions_markets(ticker)
        markets = [m for m in markets if m.get('id') == market_id]
    else:
        markets = client.get_mentions_markets(ticker)

    if not markets:
        print(f"❌ No mentions markets found for {ticker}")
        return

    print(f"✓ Found {len(markets)} relevant market(s)\n")

    # Step 2: Download transcripts
    print("Step 2: Downloading transcripts from public sources...")
    transcripts = downloader.get_recent_transcripts(ticker)

    if not transcripts:
        print(f"❌ No transcripts found for {ticker}")
        print("   Note: Try checking if the ticker symbol is correct")
        print("   or if there are recent SEC filings available.")
        return

    print(f"✓ Downloaded {len(transcripts)} transcript(s)\n")

    # Step 3: Analyze each market
    print("Step 3: Analyzing for mispricings...\n")

    for market in markets:
        # Analyze all transcripts
        analyses = []
        for transcript in transcripts:
            analysis = analyzer.analyze_transcript(transcript, ticker)
            analyses.append(analysis)

        # Get total mentions
        total_mentions = sum(a['total_mentions'] for a in analyses)

        # Get market price (try to extract YES price)
        market_price = 0.5  # Default
        tokens = market.get('tokens', [])
        for token in tokens:
            if token.get('outcome', '').upper() == 'YES':
                price_str = token.get('price', '0.5')
                try:
                    market_price = float(price_str)
                except ValueError:
                    market_price = 0.5

        # Detect mispricing
        mispricing = analyzer.detect_mispricing(
            market_question=market.get('question', ''),
            market_price=market_price,
            actual_mentions=total_mentions
        )

        # Generate and print report
        report = analyzer.generate_report(market, analyses, mispricing)
        print(report)


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
        description='Polymarket Mentions Bot - Identify mispricings in mentions markets'
    )
    parser.add_argument(
        '--scan',
        action='store_true',
        help='Scan and display all mentions markets'
    )
    parser.add_argument(
        '--ticker',
        type=str,
        help='Ticker symbol to analyze (e.g., AAPL, TSLA)'
    )
    parser.add_argument(
        '--market-id',
        type=str,
        help='Specific market ID to analyze'
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
        analyze_ticker(args.ticker, args.market_id)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
