import { priceService } from "../priceService";

export interface FeeBreakdown {
    notionalUsd: number;
    feeBps: number;
    feeUsd: number;
    feeVaultUsd: number;
    feePlatformUsd: number;
    feeSol: number; // approximate SOL amount (floating)
    feeVaultSol: number;
    feePlatformSol: number;
    feeLamports: number; // integer lamports total
    feeVaultLamports: number;
    feePlatformLamports: number;
    usedSolPrice: number; // USD per SOL used for conversion
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Calculate fees on a trade notional (USD), split between vault and platform,
 * and convert amounts to SOL/lamports using the server priceService.
 *
 * Rounding policy:
 * - USD-level calculations use floating numbers but are clamped by min/max.
 * - SOL -> lamports conversion rounds up (Math.ceil) to avoid undercharging.
 *
 * @param notionalUsd Trade notional in USD (price * size)
 * @param feeBps Fee in basis points (bps) where 100 bps = 1%
 * @param vaultSharePct Fraction [0..1] of fee routed to vault (default 0.7)
 * @param options.minFeeUsd Minimum fee in USD (default 0.01)
 * @param options.maxFeeUsd Optional maximum fee in USD
 */
export function calculateFees(
    notionalUsd: number,
    feeBps: number,
    vaultSharePct = 0.7,
    options?: { minFeeUsd?: number; maxFeeUsd?: number }
): FeeBreakdown {
    const minFeeUsd = options?.minFeeUsd ?? 0.01;
    const maxFeeUsd = options?.maxFeeUsd;

    if (notionalUsd <= 0 || feeBps <= 0) {
        return {
            notionalUsd,
            feeBps,
            feeUsd: 0,
            feeVaultUsd: 0,
            feePlatformUsd: 0,
            feeSol: 0,
            feeVaultSol: 0,
            feePlatformSol: 0,
            feeLamports: 0,
            feeVaultLamports: 0,
            feePlatformLamports: 0,
            usedSolPrice: 0,
        };
    }

    // fee in USD (floating). Use basis points: fee = notional * feeBps / 10000
    let feeUsd = (notionalUsd * feeBps) / 10000;

    if (feeUsd < minFeeUsd) feeUsd = minFeeUsd;
    if (typeof maxFeeUsd === "number" && feeUsd > maxFeeUsd) feeUsd = maxFeeUsd;

    const feeVaultUsd = feeUsd * vaultSharePct;
    const feePlatformUsd = feeUsd - feeVaultUsd;

    // Get SOL price from priceService
    const solPriceData = priceService.getPrice("SOL");
    const usedSolPrice = solPriceData ? solPriceData.price : 0;

    // Convert USD fees to SOL and lamports. If price unavailable, set SOL/lamports to 0
    let feeSol = 0;
    let feeVaultSol = 0;
    let feePlatformSol = 0;
    let feeLamports = 0;
    let feeVaultLamports = 0;
    let feePlatformLamports = 0;

    if (usedSolPrice > 0) {
        feeSol = feeUsd / usedSolPrice;
        feeVaultSol = feeVaultUsd / usedSolPrice;
        feePlatformSol = feePlatformUsd / usedSolPrice;

        // Convert to lamports and ceil to avoid fractional lamport loss
        feeLamports = Math.ceil(feeSol * LAMPORTS_PER_SOL);
        feeVaultLamports = Math.ceil(feeVaultSol * LAMPORTS_PER_SOL);
        feePlatformLamports = feeLamports - feeVaultLamports;
        if (feePlatformLamports < 0) feePlatformLamports = 0; // safety
    }

    return {
        notionalUsd,
        feeBps,
        feeUsd,
        feeVaultUsd,
        feePlatformUsd,
        feeSol,
        feeVaultSol,
        feePlatformSol,
        feeLamports,
        feeVaultLamports,
        feePlatformLamports,
        usedSolPrice,
    };
}

export default calculateFees;

export interface VaultComposition {
    creator: { uid: string; lamports: number } | null;
    contributors: Array<{ uid: string; lamports: number }>;
}

export interface DistributionResult {
    totalFeeLamports: number;
    platformLamports: number;
    creatorLamports: number;
    contributors: Array<{ uid: string; lamports: number }>;
    // debug fields
    allocatedSum: number;
}

/**
 * Distribute a total fee (in lamports) pro-rata across the vault composition.
 * For each capital owner (creator or contributor) we compute their share of
 * the vault capital, allocate that portion of the fee, then apply an
 * owner-specific keep percentage. The platform receives the platform portion
 * from each owner's allocated fee. This function guarantees the integer
 * lamport allocations sum up to `totalFeeLamports` by assigning any rounding
 * remainder to the platform.
 *
 * @param totalFeeLamports total fee amount in lamports
 * @param composition vault composition: creator + contributors with lamports
 * @param creatorKeepPct fraction [0..1] of owner-allocated fee that the creator keeps (default 0.6)
 * @param contributorKeepPct fraction [0..1] that each contributor keeps of their owner-allocated fee (default 0.6)
 */
export function distributeFeeProRata(
    totalFeeLamports: number,
    composition: VaultComposition,
    creatorKeepPct = 0.6,
    contributorKeepPct = 0.6
): DistributionResult {
    if (totalFeeLamports <= 0) {
        return {
            totalFeeLamports: 0,
            platformLamports: 0,
            creatorLamports: 0,
            contributors: [],
            allocatedSum: 0,
        };
    }

    const creatorLamports = composition.creator ? composition.creator.lamports : 0;
    const contribTotal = composition.contributors.reduce((s, c) => s + c.lamports, 0);
    const totalCapital = creatorLamports + contribTotal;

    if (totalCapital <= 0) {
        return {
            totalFeeLamports,
            platformLamports: totalFeeLamports,
            creatorLamports: 0,
            contributors: [],
            allocatedSum: totalFeeLamports,
        };
    }

    let platformAcc = 0;
    let creatorAcc = 0;
    const contributorsAcc: Array<{ uid: string; lamports: number }> = [];

    // Track allocated portion (owner_fee_portion) sum to compute remainder
    let allocatedPortionSum = 0;

    // Helper to allocate owner portion
    function allocateOwner(ownerLamports: number, keepPct: number) {
        // owner's share of total fee (floor to avoid over-allocating)
        const ownerPortion = Math.floor((totalFeeLamports * ownerLamports) / totalCapital);
        allocatedPortionSum += ownerPortion;
        const ownerKeep = Math.floor(ownerPortion * keepPct);
        const ownerPlatform = ownerPortion - ownerKeep;
        return { ownerPortion, ownerKeep, ownerPlatform };
    }

    if (composition.creator) {
        const { ownerKeep, ownerPlatform, ownerPortion } = allocateOwner(creatorLamports, creatorKeepPct);
        creatorAcc += ownerKeep;
        platformAcc += ownerPlatform;
    }

    for (const c of composition.contributors) {
        const { ownerKeep, ownerPlatform, ownerPortion } = allocateOwner(c.lamports, contributorKeepPct);
        contributorsAcc.push({ uid: c.uid, lamports: ownerKeep });
        platformAcc += ownerPlatform;
    }

    // Handle remainder due to integer division rounding
    const remainder = totalFeeLamports - allocatedPortionSum;
    if (remainder > 0) {
        // Put remainder to platform
        platformAcc += remainder;
    }

    // Compute allocated sum for verification
    const allocatedSum = creatorAcc + platformAcc + contributorsAcc.reduce((s, c) => s + c.lamports, 0);

    return {
        totalFeeLamports,
        platformLamports: platformAcc,
        creatorLamports: creatorAcc,
        contributors: contributorsAcc,
        allocatedSum,
    };
}

