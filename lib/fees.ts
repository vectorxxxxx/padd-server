// Server-local copy of padd-ui/engine/fees.ts
import { getAdminDb } from './firebaseAdmin';

export interface FeeSolBreakdown {
    notionalUsd: number;
    feeBps: number;
    feeUsd: number;
    feeSol: number;
    feeVaultSol: number;
    feePlatformSol: number;
    usedSolPrice: number;
}

export function calculateFeesUsdToSol(notionalUsd: number, feeBps: number, solPrice: number, vaultSharePct = 0.7, options?: { minFeeUsd?: number; maxFeeUsd?: number }): FeeSolBreakdown {
    const minFeeUsd = options?.minFeeUsd ?? 0.01
    const maxFeeUsd = options?.maxFeeUsd

    if (!notionalUsd || feeBps <= 0) {
        return { notionalUsd, feeBps, feeUsd: 0, feeSol: 0, feeVaultSol: 0, feePlatformSol: 0, usedSolPrice: solPrice || 0 }
    }

    let feeUsd = (notionalUsd * feeBps) / 10000
    if (feeUsd < minFeeUsd) feeUsd = minFeeUsd
    if (typeof maxFeeUsd === 'number' && feeUsd > maxFeeUsd) feeUsd = maxFeeUsd

    const feeSol = solPrice > 0 ? feeUsd / solPrice : 0
    const feeVaultSol = feeSol * vaultSharePct
    const feePlatformSol = feeSol - feeVaultSol

    return { notionalUsd, feeBps, feeUsd, feeSol, feeVaultSol, feePlatformSol, usedSolPrice: solPrice }
}

export interface VaultCompositionSol {
    creator?: { uid: string; sol: number }
    contributors?: Array<{ uid: string; sol: number }>
}

export interface DistributionSolResult {
    totalFeeSol: number
    platformSol: number
    creatorSol: number
    contributors: Array<{ uid: string; sol: number }>
    allocatedSum: number
}

export function distributeFeeProRataSol(totalFeeSol: number, composition: VaultCompositionSol, creatorKeepPct = 0.6, contributorKeepPct = 0.6): DistributionSolResult {
    if (!totalFeeSol || totalFeeSol <= 0) {
        return { totalFeeSol: 0, platformSol: 0, creatorSol: 0, contributors: [], allocatedSum: 0 }
    }

    const creatorSol = composition.creator?.sol ?? 0
    const contribTotal = (composition.contributors || []).reduce((s, c) => s + (c.sol || 0), 0)
    const totalCapital = creatorSol + contribTotal
    if (totalCapital <= 0) {
        return { totalFeeSol, platformSol: totalFeeSol, creatorSol: 0, contributors: [], allocatedSum: totalFeeSol }
    }

    let platformAcc = 0
    let creatorAcc = 0
    const contributorsAcc: Array<{ uid: string; sol: number }> = []
    let allocatedPortion = 0

    function allocateOwner(ownerSol: number, keepPct: number) {
        const ownerPortion = (totalFeeSol * ownerSol) / totalCapital
        allocatedPortion += ownerPortion
        const ownerKeep = ownerPortion * keepPct
        const ownerPlatform = ownerPortion - ownerKeep
        return { ownerPortion, ownerKeep, ownerPlatform }
    }

    if (composition.creator) {
        const creatorKeep = (typeof (composition as any).creator?.keepPct === 'number') ? (composition as any).creator.keepPct : creatorKeepPct
        const { ownerKeep, ownerPlatform } = allocateOwner(creatorSol, creatorKeep)
        creatorAcc += ownerKeep
        platformAcc += ownerPlatform
    }

    for (const c of composition.contributors || []) {
        const contribKeep = (typeof (c as any).keepPct === 'number') ? (c as any).keepPct : contributorKeepPct
        const { ownerKeep, ownerPlatform } = allocateOwner(c.sol, contribKeep)
        contributorsAcc.push({ uid: c.uid, sol: ownerKeep })
        platformAcc += ownerPlatform
    }

    const remainder = totalFeeSol - allocatedPortion
    if (remainder > 0) platformAcc += remainder

    const allocatedSum = creatorAcc + platformAcc + contributorsAcc.reduce((s, c) => s + c.sol, 0)

    return { totalFeeSol, platformSol: platformAcc, creatorSol: creatorAcc, contributors: contributorsAcc, allocatedSum }
}

export async function loadVaultComposition(mint: string): Promise<VaultCompositionSol> {
    const db = getAdminDb()
    const snap = await db.ref(`/vaults/${mint}/composition`).get()
    if (!snap.exists()) return {}
    return snap.val()
}

export default { calculateFeesUsdToSol, distributeFeeProRataSol, loadVaultComposition }
