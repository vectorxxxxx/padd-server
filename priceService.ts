// Using built-in fetch (Node.js 18+)

export interface PriceData {
    symbol: string;
    price: number;
    change24h: number;
    timestamp: number;
}

export interface PriceCache {
    [symbol: string]: PriceData;
}

class PriceService {
    private cache: PriceCache = {};
    private updateInterval: NodeJS.Timeout | null = null;
    private readonly UPDATE_INTERVAL_MS = 3000; // 3 seconds - how often we check
    private readonly API_CALL_INTERVAL_MS = 10000; // 10 seconds - how often we actually call external APIs
    private readonly TRADINGVIEW_API_BASE = 'https://scanner.tradingview.com/crypto/scan';
    private lastApiCall: number = 0;

    // TradingView symbols mapping
    private readonly SYMBOLS = {
        BTC: 'BINANCE:BTCUSDT',
        ETH: 'BINANCE:ETHUSDT',
        SOL: 'BINANCE:SOLUSDT'
    };

    constructor() {
        this.initializeCache();
    }

    private initializeCache() {
        // Initialize with default values
        Object.keys(this.SYMBOLS).forEach(symbol => {
            this.cache[symbol] = {
                symbol,
                price: 0,
                change24h: 0,
                timestamp: Date.now()
            };
        });
    }

    async start() {
        console.log('Starting price service...');

        // Initial fetch
        await this.updatePrices();

        // Set up periodic updates
        this.updateInterval = setInterval(() => {
            this.updatePrices().catch(console.error);
        }, this.UPDATE_INTERVAL_MS);

        console.log(`Price service started with ${this.UPDATE_INTERVAL_MS}ms update interval`);
    }

    stop() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
            console.log('Price service stopped');
        }
    }

    private async updatePrices() {
        try {
            const now = Date.now();

            // Check if we should make an API call (rate limiting)
            if (now - this.lastApiCall < this.API_CALL_INTERVAL_MS) {
                // Too soon since last API call, skip but log that we're serving cached data
                console.log('Serving cached prices (rate limiting active)...');
                return;
            }

            console.log('Updating crypto prices from API...');
            this.lastApiCall = now;

            // TradingView scanner API request payload (simplified structure that works)
            const payload = {
                filter: [],
                options: {
                    lang: 'en'
                },
                symbols: {
                    tickers: Object.values(this.SYMBOLS)
                },
                columns: [
                    'name',
                    'close',
                    'change'
                ],
                sort: {
                    sortBy: 'name',
                    sortOrder: 'asc'
                },
                range: [0, 10]
            };

            const response = await fetch(this.TRADINGVIEW_API_BASE, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`TradingView API error: ${response.status}`);
            }

            const data: any = await response.json();

            if (data.data && Array.isArray(data.data)) {
                const timestamp = Date.now();

                data.data.forEach((item: any) => {
                    const [symbolName, price, change24h] = item.d;

                    // Map TradingView symbol back to our symbol
                    // TradingView returns just the pair name (e.g., "BTCUSDT"), so we need to match it
                    const symbol = Object.keys(this.SYMBOLS).find(
                        key => this.SYMBOLS[key as keyof typeof this.SYMBOLS].includes(symbolName)
                    );

                    if (symbol && typeof price === 'number' && typeof change24h === 'number') {
                        this.cache[symbol] = {
                            symbol,
                            price,
                            change24h,
                            timestamp
                        };

                        console.log(`Updated ${symbol}: $${price.toFixed(2)} (${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%)`);
                    }
                });
            }

        } catch (error) {
            console.error('Error updating prices:', error);

            // Fallback: try individual symbol fetches if bulk fails
            await this.fallbackUpdate();
        }
    }

    private async fallbackUpdate() {
        console.log('Attempting fallback price updates...');

        // Alternative approach using public API endpoints
        const fallbackApis = [
            {
                url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
                parser: (data: any) => {
                    const timestamp = Date.now();
                    const updates: Partial<PriceCache> = {};

                    if (data.bitcoin) {
                        updates.BTC = {
                            symbol: 'BTC',
                            price: data.bitcoin.usd,
                            change24h: data.bitcoin.usd_24h_change || 0,
                            timestamp
                        };
                    }

                    if (data.ethereum) {
                        updates.ETH = {
                            symbol: 'ETH',
                            price: data.ethereum.usd,
                            change24h: data.ethereum.usd_24h_change || 0,
                            timestamp
                        };
                    }

                    if (data.solana) {
                        updates.SOL = {
                            symbol: 'SOL',
                            price: data.solana.usd,
                            change24h: data.solana.usd_24h_change || 0,
                            timestamp
                        };
                    }

                    return updates;
                }
            }
        ];

        for (const api of fallbackApis) {
            try {
                const response = await fetch(api.url, {
                    headers: {
                        'User-Agent': 'SLAB-Trading-Platform/1.0'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const updates = api.parser(data);

                    Object.assign(this.cache, updates);
                    console.log('Fallback price update successful');
                    return;
                }
            } catch (error) {
                console.error('Fallback API failed:', error);
            }
        }

        console.warn('All price update methods failed');
    }

    // Get all cached prices
    getAllPrices(): PriceCache {
        return { ...this.cache };
    }

    // Get specific price
    getPrice(symbol: string): PriceData | null {
        return this.cache[symbol.toUpperCase()] || null;
    }

    // Get prices for specific symbols
    getPrices(symbols: string[]): PriceCache {
        const result: PriceCache = {};
        symbols.forEach(symbol => {
            const upperSymbol = symbol.toUpperCase();
            if (this.cache[upperSymbol]) {
                result[upperSymbol] = this.cache[upperSymbol];
            }
        });
        return result;
    }

    // Check if data is stale (older than 30 seconds)
    isStale(symbol?: string): boolean {
        const now = Date.now();
        const staleThreshold = 30 * 1000; // 30 seconds

        if (symbol) {
            const data = this.cache[symbol.toUpperCase()];
            return !data || (now - data.timestamp) > staleThreshold;
        }

        // Check if any data is stale
        return Object.values(this.cache).some(data =>
            (now - data.timestamp) > staleThreshold
        );
    }

    // Force refresh prices
    async refresh(): Promise<void> {
        await this.updatePrices();
    }

    // Get service status
    getStatus() {
        const now = Date.now();
        return {
            isRunning: this.updateInterval !== null,
            updateInterval: this.UPDATE_INTERVAL_MS,
            lastUpdate: Math.max(...Object.values(this.cache).map(p => p.timestamp)),
            symbols: Object.keys(this.cache),
            isStale: this.isStale(),
            prices: Object.values(this.cache).map(p => ({
                symbol: p.symbol,
                price: p.price,
                change24h: p.change24h,
                age: now - p.timestamp
            }))
        };
    }
}

// Export singleton instance
export const priceService = new PriceService();