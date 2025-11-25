# Polymarket Mentions Bot

A lightweight terminal-based bot that identifies mispricing opportunities in Polymarket mentions markets by comparing market prices with actual mention counts from public transcripts.

## Features

- 🔍 Scans Polymarket for mentions markets
- 📄 Downloads transcripts from public sources (SEC EDGAR filings)
- 🎯 Counts actual mentions of tickers in transcripts
- 💡 Identifies mispricings by comparing market prices with reality
- 🚀 Lightweight CLI interface - no frontend needed

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd MentionsBot2
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. (Optional) Copy and configure environment variables:
```bash
cp .env.example .env
```

## Usage

### Interactive Mode

The easiest way to use the bot:

```bash
python main.py --interactive
```

Or simply:
```bash
python main.py
```

This will launch an interactive menu where you can:
- Scan all mentions markets
- Analyze specific tickers
- Exit when done

### Command-Line Mode

#### Scan all mentions markets:
```bash
python main.py --scan
```

#### Analyze a specific ticker:
```bash
python main.py --ticker AAPL
```

#### Analyze a ticker for a specific market:
```bash
python main.py --ticker TSLA --market-id <market-id>
```

## How It Works

1. **Market Discovery**: The bot searches Polymarket for markets related to mentions (e.g., "Will company X be mentioned N times in earnings call?")

2. **Transcript Collection**: When you provide a ticker, it downloads recent SEC filings (8-K forms, which often contain earnings call information)

3. **Mention Analysis**: The bot counts how many times the ticker appears in the transcripts

4. **Mispricing Detection**: Compares the actual mention count with the market's implied probability:
   - If a stock was mentioned 10 times but the market prices "5+ mentions" at 30%, that's a mispricing
   - The bot calculates the expected price and identifies BUY opportunities

5. **Report Generation**: Provides a detailed report with:
   - Current market prices
   - Actual mention counts from transcripts
   - Mispricing analysis
   - Trading opportunities (BUY_YES or BUY_NO)
   - Confidence levels

## Example Output

```
================================================================================
ANALYSIS REPORT
================================================================================

Market Question: Will AAPL be mentioned 5 or more times in Q4 earnings call?
Market ID: abc123

Current Market Prices:
  YES: 0.45
  NO: 0.55

Transcripts Analyzed: 2

Source: SEC (2024-01-15)
  Total Mentions: 12
  Details: {'AAPL': 8, 'Apple': 4}
  URL: https://www.sec.gov/...

TOTAL MENTIONS ACROSS ALL TRANSCRIPTS: 12

================================================================================
MISPRICING ANALYSIS
================================================================================

Condition Met: YES
Market Price (YES): 45.00%
Expected Price: 95.00%
Price Difference: 50.00%
Mispriced: YES
Confidence: HIGH

🎯 OPPORTUNITY: BUY_YES
   → Market is underpricing. Consider buying YES shares.

================================================================================
```

## Data Sources

Currently supported:
- **SEC EDGAR**: 8-K filings (earnings reports)

Future enhancements could include:
- SeekingAlpha transcripts (requires API key)
- Company investor relations pages
- FOMC meeting transcripts
- Conference call transcripts

## Limitations

- **Public Data Only**: Uses freely available SEC filings. Premium services may provide more comprehensive transcripts
- **Rate Limiting**: Respectful delays built in for SEC requests
- **Ticker Matching**: Simple string matching - may need enhancement for complex cases
- **Market Coverage**: Only scans active/open markets

## Configuration

Edit the source files to customize:
- `polymarket_client.py`: Adjust market search parameters
- `transcript_downloader.py`: Add additional transcript sources
- `mentions_analyzer.py`: Tune mispricing detection thresholds

## Tips

1. **Best for Clear-Cut Cases**: Works best when there's obvious mispricing (e.g., 20 mentions vs market pricing at 30%)

2. **Verify Manually**: Always verify the bot's findings before trading

3. **Check Market Questions**: Make sure you understand exactly what the market is asking (some have specific conditions)

4. **Recent Data**: The bot fetches recent filings - make sure they're relevant to the market's timeframe

5. **Rate Limits**: Be respectful of SEC rate limits if running frequent scans

## Development

### Project Structure
```
MentionsBot2/
├── main.py                    # CLI entry point
├── polymarket_client.py       # Polymarket API interface
├── transcript_downloader.py   # Transcript fetching
├── mentions_analyzer.py       # Analysis and mispricing detection
├── requirements.txt           # Dependencies
├── .env.example              # Environment template
└── README.md                 # This file
```

### Adding New Features

To add a new transcript source:
1. Edit `transcript_downloader.py`
2. Add a new method to fetch from your source
3. Update `get_recent_transcripts()` to include it

To adjust mispricing thresholds:
1. Edit `mentions_analyzer.py`
2. Modify `detect_mispricing()` method

## Disclaimer

This tool is for informational and educational purposes only. It does not constitute financial advice. Always do your own research before making any trading decisions. The accuracy of transcript data and market analysis is not guaranteed.

## License

MIT License - feel free to modify and extend!

## Contributing

Contributions welcome! Some ideas:
- Add more transcript sources
- Improve ticker/company name matching
- Add support for different types of mentions markets
- Implement caching for faster repeated queries
- Add export functionality for results

## Support

For issues or questions, please open an issue on GitHub.
