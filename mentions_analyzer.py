"""
Analyzer for counting mentions in transcripts and identifying mispricings
"""
import re
from typing import List, Dict, Tuple
from collections import Counter


class MentionsAnalyzer:
    """Analyze transcripts for mentions and compare with market prices"""

    def __init__(self):
        pass

    def count_mentions(self, text: str, search_terms: List[str], case_sensitive: bool = False) -> Dict[str, int]:
        """
        Count occurrences of search terms in text
        Returns dict of term -> count
        """
        if not case_sensitive:
            text = text.lower()
            search_terms = [term.lower() for term in search_terms]

        counts = {}
        for term in search_terms:
            # Use word boundaries to avoid partial matches
            pattern = r'\b' + re.escape(term) + r'\b'
            matches = re.findall(pattern, text, re.IGNORECASE if not case_sensitive else 0)
            counts[term] = len(matches)

        return counts

    def analyze_transcript(self, transcript: Dict, ticker: str) -> Dict:
        """
        Analyze a single transcript for ticker mentions
        Returns analysis results
        """
        text = transcript.get('text', '')

        # Generate search variations for the ticker
        search_terms = self._generate_search_terms(ticker)

        # Count mentions
        mention_counts = self.count_mentions(text, search_terms)

        total_mentions = sum(mention_counts.values())

        return {
            'source': transcript.get('source', 'Unknown'),
            'date': transcript.get('date', 'Unknown'),
            'url': transcript.get('url', ''),
            'mention_counts': mention_counts,
            'total_mentions': total_mentions,
            'text_length': len(text)
        }

    def _generate_search_terms(self, ticker: str) -> List[str]:
        """Generate possible search term variations for a ticker"""
        terms = [ticker, ticker.upper(), ticker.lower()]

        # Add common variations (company names could be added here)
        # For example: AAPL -> Apple, TSLA -> Tesla
        # This is a simple version; could be enhanced with a ticker->name mapping

        return list(set(terms))  # Remove duplicates

    def detect_mispricing(self,
                          market_question: str,
                          market_price: float,
                          actual_mentions: int,
                          threshold: int = 1) -> Dict:
        """
        Detect if there's a mispricing between market price and actual mentions

        Args:
            market_question: The market question text
            market_price: Current "YES" price (0-1, where 1 = 100%)
            actual_mentions: Actual count of mentions found
            threshold: Mention threshold from market question

        Returns:
            Dict with mispricing analysis
        """
        # Extract threshold from question if possible
        threshold_match = re.search(r'(\d+)\s*(?:or more|times|\+)', market_question)
        if threshold_match:
            threshold = int(threshold_match.group(1))

        # Determine if condition is met
        condition_met = actual_mentions >= threshold

        # Calculate expected price based on reality
        # If condition is clearly met, expected price should be ~1.0
        # If clearly not met, expected price should be ~0.0
        if condition_met:
            expected_price = 0.95  # High confidence YES
        else:
            expected_price = 0.05  # High confidence NO

        # Calculate mispricing magnitude
        price_difference = abs(market_price - expected_price)

        # Determine if there's a significant mispricing
        is_mispriced = price_difference > 0.15  # 15% threshold

        opportunity = None
        if is_mispriced:
            if market_price < expected_price - 0.15:
                opportunity = "BUY_YES"  # Market underpricing, buy YES
            elif market_price > expected_price + 0.15:
                opportunity = "BUY_NO"  # Market overpricing, buy NO

        return {
            'is_mispriced': is_mispriced,
            'market_price': market_price,
            'expected_price': expected_price,
            'price_difference': price_difference,
            'actual_mentions': actual_mentions,
            'threshold': threshold,
            'condition_met': condition_met,
            'opportunity': opportunity,
            'confidence': self._calculate_confidence(actual_mentions, threshold, price_difference)
        }

    def _calculate_confidence(self, mentions: int, threshold: int, price_diff: float) -> str:
        """Calculate confidence level in the mispricing"""
        # More mentions away from threshold = higher confidence
        mention_distance = abs(mentions - threshold)

        if price_diff > 0.4 and mention_distance > 3:
            return "HIGH"
        elif price_diff > 0.25 and mention_distance > 1:
            return "MEDIUM"
        elif price_diff > 0.15:
            return "LOW"
        else:
            return "NONE"

    def generate_report(self, market: Dict, analyses: List[Dict], mispricing: Dict) -> str:
        """Generate a formatted report of the analysis"""
        report = "\n" + "=" * 80 + "\n"
        report += f"ANALYSIS REPORT\n"
        report += "=" * 80 + "\n\n"

        report += f"Market Question: {market.get('question', 'N/A')}\n"
        report += f"Market ID: {market.get('id', 'N/A')}\n\n"

        # Current market prices (Gamma API format)
        outcomes = market.get('outcomes', [])
        outcome_prices = market.get('outcomePrices', [])

        if outcomes and outcome_prices:
            report += "Current Market Prices:\n"
            try:
                # Parse JSON strings if needed
                if isinstance(outcomes, str):
                    import json
                    outcomes = json.loads(outcomes)
                if isinstance(outcome_prices, str):
                    import json
                    outcome_prices = json.loads(outcome_prices)

                for i, outcome in enumerate(outcomes):
                    if i < len(outcome_prices):
                        price = outcome_prices[i]
                        if isinstance(price, (int, float)):
                            report += f"  {outcome}: {price:.2%}\n"
                        else:
                            report += f"  {outcome}: {price}\n"
            except Exception:
                report += f"  Outcomes: {outcomes}\n"
                report += f"  Prices: {outcome_prices}\n"
            report += "\n"

        # Transcript analysis
        report += f"Transcripts Analyzed: {len(analyses)}\n\n"

        total_mentions = 0
        for analysis in analyses:
            report += f"Source: {analysis['source']} ({analysis['date']})\n"
            report += f"  Total Mentions: {analysis['total_mentions']}\n"
            report += f"  Details: {analysis['mention_counts']}\n"
            report += f"  URL: {analysis['url']}\n\n"
            total_mentions += analysis['total_mentions']

        report += f"TOTAL MENTIONS ACROSS ALL TRANSCRIPTS: {total_mentions}\n\n"

        # Mispricing analysis
        report += "=" * 80 + "\n"
        report += "MISPRICING ANALYSIS\n"
        report += "=" * 80 + "\n\n"

        report += f"Condition Met: {'YES' if mispricing['condition_met'] else 'NO'}\n"
        report += f"Market Price (YES): {mispricing['market_price']:.2%}\n"
        report += f"Expected Price: {mispricing['expected_price']:.2%}\n"
        report += f"Price Difference: {mispricing['price_difference']:.2%}\n"
        report += f"Mispriced: {'YES' if mispricing['is_mispriced'] else 'NO'}\n"
        report += f"Confidence: {mispricing['confidence']}\n"

        if mispricing['opportunity']:
            report += f"\n🎯 OPPORTUNITY: {mispricing['opportunity']}\n"
            if mispricing['opportunity'] == 'BUY_YES':
                report += "   → Market is underpricing. Consider buying YES shares.\n"
            else:
                report += "   → Market is overpricing. Consider buying NO shares.\n"

        report += "\n" + "=" * 80 + "\n"

        return report


if __name__ == "__main__":
    # Test the analyzer
    analyzer = MentionsAnalyzer()

    # Test mention counting
    test_text = "Apple released new products. AAPL stock is performing well. Apple CEO spoke about innovation."
    counts = analyzer.count_mentions(test_text, ['Apple', 'AAPL'])
    print(f"Mention counts: {counts}")
    print(f"Total: {sum(counts.values())}")
