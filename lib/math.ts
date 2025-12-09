// Copied from padd-ui/engine/math.ts (server-local copy)

/**
 * Engine math helpers (server copy)
 */

const YEAR_SECONDS = 365 * 24 * 60 * 60

export function leverageFromBps(leverageBps: number) {
    return Math.max(1, leverageBps / 10000)
}

export function computeBorrowSol(collateralSol: number, leverageBps: number) {
    const lev = leverageFromBps(leverageBps)
    return collateralSol * (lev - 1)
}

export function computeSizeToken(collateralSol: number, borrowSol: number, solUsd: number, tokenUsd: number) {
    const notionalUsd = (collateralSol + borrowSol) * solUsd
    return notionalUsd / tokenUsd
}

export function computePnlSol(sizeToken: number, entryUsd: number, markUsd: number, solUsd: number) {
    const pnlUsd = sizeToken * (markUsd - entryUsd)
    return pnlUsd / solUsd
}

export function computeInterestSol(borrowSol: number, aprBps: number, dtSeconds: number) {
    const apr = aprBps / 10000
    return borrowSol * apr * (dtSeconds / YEAR_SECONDS)
}

export function computeEquitySol(collateralSol: number, pnlSol: number, interestSol: number, feesSol: number) {
    return collateralSol + pnlSol - interestSol - feesSol
}

export function computeMrBps(equitySol: number, sizeToken: number, markUsd: number, solUsd: number) {
    const notionalUsd = sizeToken * markUsd
    const notionalSol = notionalUsd / solUsd
    if (notionalSol <= 0) return 0
    const mr = equitySol / notionalSol
    return Math.floor(mr * 10000)
}

export function formatBps(bps: number) {
    return `${(bps / 100).toFixed(2)}%`
}

export { YEAR_SECONDS }
