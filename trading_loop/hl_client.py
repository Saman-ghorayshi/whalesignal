"""trading_loop/hl_client.py — Hyperliquid testnet wrapper.

Uses the official hyperliquid-python-sdk for EIP-712 signing (the docs say
"it is recommended to use an existing SDK" — we obey). Two thin wrappers:
  - whale_fills(address): get whale's recent HL position changes
  - open_market(coin, is_buy, sz): paper order on testnet
  - close_market(coin, sz): close a paper position
  - mid_price(coin): current mid for TP/SL checks

The SDK does the signing. We don't hand-roll EIP-712.
"""

from hyperliquid.info import Info
from hyperliquid.exchange import Exchange
from hyperliquid.utils.types import Cloid
from eth_account import Account

TESTNET_URL = "https://api.hyperliquid-testnet.xyz"
MAINNET_URL = "https://api.hyperliquid.xyz"

# Hyperliquid rejects orders below ~$10 notional. Enforced in usd_to_sz
# so we skip the signal with a reason instead of sending a doomed order.
MIN_ORDER_NOTIONAL_USD = 10.0


class HLClient:
    def __init__(self, wallet_private_key: str, testnet: bool = True):
        self.account = Account.from_key(wallet_private_key)
        self.address = self.account.address
        url = TESTNET_URL if testnet else MAINNET_URL
        self.info = Info(url)
        self.exchange = Exchange(
            self.account, url, account_address=self.address
        )
        self._sz_decimals_cache = {}

    def whale_fills(self, whale_address: str) -> list:
        """Get recent HL fills for a whale wallet. Public, no key needed."""
        return self.info.user_fills(whale_address)

    def mid_price(self, coin: str) -> float:
        """Current mid price for a perp."""
        all_mids = self.info.all_mids()
        return float(all_mids.get(coin, 0))

    def sz_decimals(self, coin: str) -> int:
        """Per-coin size decimals from exchange meta (cached). Falls back to 2."""
        if coin in self._sz_decimals_cache:
            return self._sz_decimals_cache[coin]
        decimals = 2
        try:
            for asset in self.info.meta().get("universe", []):
                if asset.get("name") == coin:
                    decimals = int(asset.get("szDecimals", 2))
                    break
        except Exception:
            pass
        self._sz_decimals_cache[coin] = decimals
        return decimals

    def usd_to_sz(self, coin: str, size_usd: float, mid: float) -> float:
        """Convert a USD notional to coin units, quantized to szDecimals.

        Hyperliquid's market_open/market_close expect size in COIN units,
        not USD — passing USD here was a ~1000x sizing bug (T1).

        Raises ValueError when the price is unknown or the notional is below
        the ~$10 minimum order size (caller should skip with a reason).
        """
        if not mid or mid <= 0:
            raise ValueError(f"no mid price for {coin}")
        if size_usd <= 0:
            raise ValueError(f"non-positive size_usd {size_usd} for {coin}")
        sz = round(size_usd / mid, self.sz_decimals(coin))
        if sz * mid < MIN_ORDER_NOTIONAL_USD:
            raise ValueError(
                f"notional ${sz * mid:.2f} below ${MIN_ORDER_NOTIONAL_USD:.0f} "
                f"minimum for {coin}"
            )
        return sz

    def open_market(self, coin: str, is_buy: bool, sz: float) -> dict:
        """Open a market position on testnet. Returns exchange response."""
        return self.exchange.market_open(coin, is_buy, sz, slippage=0.05)

    def close_market(self, coin: str, sz: float = None) -> dict:
        """Close a market position. sz=None closes entire position."""
        return self.exchange.market_close(coin, sz=sz, slippage=0.05)

    def user_state(self) -> dict:
        """Get our own positions and margin state."""
        return self.info.user_state(self.address)
