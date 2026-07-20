"""trading_loop/hl_client.py — Hyperliquid testnet wrapper.

Uses the official hyperliquid-python-sdk for EIP-712 signing (the docs say
"it is recommended to use an existing SDK" — we obey). Two thin wrappers:
  - whale_fills(address): get whale's recent HL position changes
  - open_market(coin, is_buy, sz): paper order on testnet
  - close_market(coin, sz): close a paper position
  - mid_price(coin): current mid for TP/SL checks

ponytail: the SDK does the signing. We don't hand-roll EIP-712.
"""

from hyperliquid.info import Info
from hyperliquid.exchange import Exchange
from hyperliquid.utils.types import Cloid
from eth_account import Account

TESTNET_URL = "https://api.hyperliquid-testnet.xyz"
MAINNET_URL = "https://api.hyperliquid.xyz"


class HLClient:
    def __init__(self, wallet_private_key: str, testnet: bool = True):
        self.account = Account.from_key(wallet_private_key)
        self.address = self.account.address
        url = TESTNET_URL if testnet else MAINNET_URL
        self.info = Info(url, skip_ws=True)
        self.exchange = Exchange(
            self.account, url, account_address=self.address, skip_ws=True
        )

    def whale_fills(self, whale_address: str) -> list:
        """Get recent HL fills for a whale wallet. Public, no key needed."""
        return self.info.user_fills(whale_address)

    def mid_price(self, coin: str) -> float:
        """Current mid price for a perp."""
        all_mids = self.info.all_mids()
        return float(all_mids.get(coin, 0))

    def open_market(self, coin: str, is_buy: bool, sz: float) -> dict:
        """Open a market position on testnet. Returns exchange response."""
        return self.exchange.market_open(coin, is_buy, sz, slippage=0.05)

    def close_market(self, coin: str, sz: float = None) -> dict:
        """Close a market position. sz=None closes entire position."""
        return self.exchange.market_close(coin, sz=sz, slippage=0.05)

    def user_state(self) -> dict:
        """Get our own positions and margin state."""
        return self.info.user_state(self.address)
