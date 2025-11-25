"""
Transcript downloader for fetching earnings call transcripts and other public sources
"""
import requests
from bs4 import BeautifulSoup
from typing import List, Dict, Optional
import re
import time


class TranscriptDownloader:
    """Download transcripts from various public sources"""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })

    def get_sec_filings(self, ticker: str, filing_type: str = "8-K") -> List[Dict]:
        """
        Fetch SEC filings for a ticker
        8-K filings often contain earnings call information
        """
        try:
            # SEC EDGAR search
            search_url = f"https://www.sec.gov/cgi-bin/browse-edgar"
            params = {
                'action': 'getcompany',
                'CIK': ticker,
                'type': filing_type,
                'dateb': '',
                'owner': 'exclude',
                'count': 10,
                'search_text': ''
            }

            response = self.session.get(search_url, params=params, timeout=15)
            response.raise_for_status()

            soup = BeautifulSoup(response.content, 'html.parser')
            filings = []

            # Parse the results table
            table = soup.find('table', {'class': 'tableFile2'})
            if table:
                rows = table.find_all('tr')[1:]  # Skip header
                for row in rows[:5]:  # Get recent 5 filings
                    cols = row.find_all('td')
                    if len(cols) >= 4:
                        filing_date = cols[3].text.strip()
                        doc_link = cols[1].find('a')
                        if doc_link:
                            filing_url = f"https://www.sec.gov{doc_link['href']}"
                            filings.append({
                                'date': filing_date,
                                'url': filing_url,
                                'type': filing_type
                            })

            # Rate limiting for SEC
            time.sleep(0.1)
            return filings

        except Exception as e:
            print(f"Error fetching SEC filings: {e}")
            return []

    def download_transcript_text(self, url: str) -> Optional[str]:
        """Download and extract text from a URL"""
        try:
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
