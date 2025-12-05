import { beforeEach, describe, expect, it, vi } from 'vitest';
import { priceService } from '../priceService';
import calculateFees from '../utils/fees';

describe('calculateFees', () => {
    beforeEach(() => {
        // Reset any spies
        vi.restoreAllMocks();
    });

    it('applies min fee when calculated fee is below minFeeUsd', () => {
        // Mock SOL price to a known value
        vi.spyOn(priceService, 'getPrice').mockReturnValue({ price: 50, change24h: 0, timestamp: Date.now() } as any);

        // tiny notional
        const breakdown = calculateFees(0.5, 10, 0.7, { minFeeUsd: 0.01 });

        expect(breakdown.feeUsd).toBeCloseTo(0.01);
        expect(breakdown.feeVaultUsd).toBeCloseTo(0.007);
        expect(breakdown.feePlatformUsd).toBeCloseTo(0.003);

        // SOL conversion: 0.01 USD at $50/SOL = 0.0002 SOL => lamports = ceil(0.0002 * 1e9) = 200000
        expect(breakdown.feeLamports).toBe(200000);
        expect(breakdown.feeVaultLamports).toBe(140000);
        expect(breakdown.feePlatformLamports).toBe(60000);
    });

    it('calculates fees and splits correctly for normal notional', () => {
        vi.spyOn(priceService, 'getPrice').mockReturnValue({ price: 40, change24h: 0, timestamp: Date.now() } as any);

        // notional = $100, bps=10 => fee = 100 * 10 / 10000 = $0.10
        const b = calculateFees(100, 10, 0.7, { minFeeUsd: 0.01 });
        expect(b.feeUsd).toBeCloseTo(0.1);
        expect(b.feeVaultUsd).toBeCloseTo(0.07);
        expect(b.feePlatformUsd).toBeCloseTo(0.03);

        // SOL conversion: 0.1 USD / $40 = 0.0025 SOL => lamports = ceil(0.0025 * 1e9) = 2500000
        expect(b.feeLamports).toBe(2500000);
        // vault lamports = ceil(0.07/40 * 1e9) = ceil(1_750_000) = 1750000
        expect(b.feeVaultLamports).toBe(1750000);
        expect(b.feePlatformLamports).toBe(750000);

        // used price should be present
        expect(b.usedSolPrice).toBeGreaterThan(0);
    });

    it('returns zero lamports when SOL price is unavailable', () => {
        vi.spyOn(priceService, 'getPrice').mockReturnValue(null as any);

        const b = calculateFees(1000, 20, 0.6, { minFeeUsd: 0.01 });
        expect(b.feeUsd).toBeCloseTo((1000 * 20) / 10000);
        expect(b.usedSolPrice).toBe(0);
        expect(b.feeLamports).toBe(0);
        expect(b.feeVaultLamports).toBe(0);
        expect(b.feePlatformLamports).toBe(0);
    });

    it('obeys maxFeeUsd when provided', () => {
        vi.spyOn(priceService, 'getPrice').mockReturnValue({ price: 100, change24h: 0, timestamp: Date.now() } as any);

        // large notional that would produce a large fee
        const b = calculateFees(1_000_000, 100, 0.5, { minFeeUsd: 0.01, maxFeeUsd: 500 });
        // computed fee without cap = 1_000_000 * 100 / 10000 = 10_000 USD, so capped to 500
        expect(b.feeUsd).toBe(500);
        expect(b.feeVaultUsd).toBe(250);
        expect(b.feePlatformUsd).toBe(250);

        // SOL conversion with price $100 => 500/100 = 5 SOL => lamports = 5 * 1e9
        expect(b.feeLamports).toBe(5 * 1_000_000_000);
        // vault should be ceil(2.5 * 1e9) = 2500000000
        expect(b.feeVaultLamports).toBe(2500000000);
        expect(b.feePlatformLamports).toBe(b.feeLamports - b.feeVaultLamports);
    });
});
