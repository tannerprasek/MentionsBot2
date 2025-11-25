"""
Transcript downloader for fetching earnings call transcripts and other public sources
Uses SEC EDGAR API with proper headers as required by SEC.gov
"""
import requests
from bs4 import BeautifulSoup
from typing import List, Dict, Optional
import re
import time
import json


class TranscriptDownloader:
    """Download transcripts from various public sources"""

    # SEC requires User-Agent with company name and email
    SEC_USER_AGENT = 'PolymarketMentionsBot research@example.com'

    def __init__(self, user_email: str = 'research@example.com'):
        """
        Initialize transcript downloader

        Args:
            user_email: Email to include in SEC requests (required by SEC.gov)
        """
        self.session = requests.Session()
        self.sec_session = requests.Session()

        # Regular session for non-SEC requests
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })

        # SEC-specific session with required headers
        self.sec_session.headers.update({
            'User-Agent': f'PolymarketMentionsBot {user_email}',
            'Accept-Encoding': 'gzip, deflate',
            'Host': 'data.sec.gov'
        })

    def get_cik_from_ticker(self, ticker: str) -> Optional[str]:
        """
        Get CIK (Central Index Key) from ticker symbol using SEC API

        Args:
            ticker: Stock ticker symbol (e.g., 'AAPL')

        Returns:
            CIK string with leading zeros, or None if not found
        """
        try:
            # Use the company tickers JSON file from SEC
            url = "https://www.sec.gov/files/company_tickers.json"
            headers = {'User-Agent': self.SEC_USER_AGENT}
            response = requests.get(url, headers=headers, timeout=10)
            response.raise_for_status()

            companies = response.json()

            # Search for ticker
            ticker_upper = ticker.upper()
            for company in companies.values():
                if company.get('ticker', '').upper() == ticker_upper:
                    # Return CIK with leading zeros (10 digits)
                    cik = str(company['cik_str']).zfill(10)
                    return cik

            return None

        except Exception as e:
            print(f"Error fetching CIK for {ticker}: {e}")
            return None

    def get_sec_filings(self, ticker: str, filing_type: str = "8-K", limit: int = 10) -> List[Dict]:
        """
        Fetch SEC filings for a ticker using SEC data API

        Args:
            ticker: Stock ticker symbol
            filing_type: Type of filing (8-K, 10-Q, 10-K, etc.)
            limit: Maximum number of filings to return

        Returns:
            List of filing dicts with 'date', 'url', 'type'
        """
        try:
            # Get CIK first
            cik = self.get_cik_from_ticker(ticker)
            if not cik:
                print(f"Could not find CIK for ticker {ticker}")
                return []

            # Use SEC data API
            url = f"https://data.sec.gov/submissions/CIK{cik}.json"
            response = self.sec_session.get(url, timeout=15)
            response.raise_for_status()

            data = response.json()
            filings = []

            # Parse recent filings
            recent_filings = data.get('filings', {}).get('recent', {})
            forms = recent_filings.get('form', [])
            filing_dates = recent_filings.get('filingDate', [])
            accession_numbers = recent_filings.get('accessionNumber', [])
            primary_documents = recent_filings.get('primaryDocument', [])

            for i in range(len(forms)):
                if forms[i] == filing_type and len(filings) < limit:
                    # Remove dashes from accession number for URL
                    acc_no = accession_numbers[i].replace('-', '')
                    filing_url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_no}/{primary_documents[i]}"

                    filings.append({
                        'date': filing_dates[i],
                        'url': filing_url,
                        'type': filing_type,
                        'accession': accession_numbers[i]
                    })

            # Rate limiting for SEC (recommended: 10 requests per second max)
            time.sleep(0.11)
            return filings

        except Exception as e:
            print(f"Error fetching SEC filings: {e}")
            return []

    def download_transcript_text(self, url: str) -> Optional[str]:
        """Download and extract text from a URL"""
        try:
            # Use SEC session for SEC URLs
            if 'sec.gov' in url:
                # Update Host header for SEC
                headers = self.sec_session.headers.copy()
                headers['Host'] = 'www.sec.gov'
                response = requests.get(url, headers=headers, timeout=15)
            else:
                response = self.session.get(url, timeout=15)

            response.raise_for_status()

            soup = BeautifulSoup(response.content, 'html.parser')

            # Extract text content
            # Remove script and style elements
            for script in soup(["script", "style"]):
                script.decompose()

            text = soup.get_text()
            # Clean up whitespace
            lines = (line.strip() for line in text.splitlines())
            chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
            text = '\n'.join(chunk for chunk in chunks if chunk)

            return text

        except Exception as e:
            print(f"Error downloading transcript from {url}: {e}")
            return None

    def get_recent_transcripts(self, ticker: str) -> List[Dict]:
        """
        Get recent transcripts for a ticker from multiple sources
        Returns list of dicts with 'source', 'date', 'text'
        """
        transcripts = []

        print(f"Fetching SEC filings for {ticker}...")
        filings = self.get_sec_filings(ticker)

        for filing in filings[:3]:  # Process top 3 recent filings
            print(f"  Downloading filing from {filing['date']}...")
            text = self.download_transcript_text(filing['url'])
            if text:
                transcripts.append({
                    'source': 'SEC',
                    'date': filing['date'],
                    'text': text,
                    'url': filing['url']
                })
                time.sleep(0.2)  # Rate limiting

        return transcripts

    def search_alternative_sources(self, ticker: str, event_type: str = "earnings") -> List[str]:
        """
        Search for alternative transcript sources
        Returns list of URLs that might contain transcripts
        """
        # This is a placeholder for additional sources
        # You could add APIs from services like:
        # - SeekingAlpha (requires API key)
        # - Motley Fool transcripts
        # - Company investor relations pages
        print(f"Note: For more comprehensive results, consider adding API keys for premium services")
        return []


if __name__ == "__main__":
    # Test the downloader
    downloader = TranscriptDownloader()
    ticker = input("Enter ticker symbol: ").upper()
    transcripts = downloader.get_recent_transcripts(ticker)
    print(f"\nFound {len(transcripts)} transcripts")
    for t in transcripts:
        print(f"  {t['source']} - {t['date']} - {len(t['text'])} characters")
