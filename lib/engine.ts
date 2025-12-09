// Server-local copy of padd-ui/engine/engine.ts with imports adjusted to server/lib
import { v4 as uuidv4 } from 'uuid'
import { coerceNum, transactionWithReadGuard } from './balanceTx'
import { calculateFeesUsdToSol, distributeFeeProRataSol, loadVaultComposition } from './fees'
import { getAdminDb } from './firebaseAdmin'
import * as math from './math'

const TAG = '[ENGINE]'

function now() {
    return Date.now()
}

export async function createVault(mint: string, creatorUid: string, params: any, name?: string, currency?: string) {
    const path = `/vaults/${mint}`
    const snap = await getAdminDb().ref(path).get()
    if (snap.exists()) {
        return { ok: false, error: 'Vault exists' }
    }
    const data: any = {
        tokenMint: mint,
        creatorUid,
        tvlSol: 0,
        totalBorrowsSol: 0,
        pendingFeesSol: 0,
        params,
        status: 'ACTIVE',
        utilBps: 0,
        updatedAt: now(),
    }
    if (currency) data.currency = currency
    if (name) data.name = name
    data.params = data.params || {}
    data.params.openFeeBps = (data.params.openFeeBps != null) ? data.params.openFeeBps : 10
    data.params.closeFeeBps = (data.params.closeFeeBps != null) ? data.params.closeFeeBps : 10
    data.params.ownerKeepPct = (data.params.ownerKeepPct != null) ? data.params.ownerKeepPct : 0.6
    data.params.vaultSharePct = (data.params.vaultSharePct != null) ? data.params.vaultSharePct : 0.7

    await getAdminDb().ref(path).set(data)
    console.info(TAG, 'createVault', mint, creatorUid, { name, currency })
    return { ok: true, vault: data }
}

export async function creatorDeposit(mint: string, amountSol: number, creatorUid: string) {
    const path = `/vaults/${mint}`
    const snap = await getAdminDb().ref(path).get()
    if (!snap.exists()) throw new Error('Vault not found')
    const v = snap.val()
    if (v.creatorUid !== creatorUid) throw new Error('not creator')
    const updates: Record<string, any> = {}
    updates[`${path}/tvlSol`] = (v.tvlSol || 0) + amountSol
    updates[`${path}/updatedAt`] = now()
    const compCreatorPath = `${path}/composition/creator`
    const prevCreatorSol = (v.composition && v.composition.creator && typeof v.composition.creator.sol === 'number') ? v.composition.creator.sol : 0
    updates[compCreatorPath] = { uid: creatorUid, sol: prevCreatorSol + amountSol }
    const eventId = uuidv4()
    updates[`/trades/${mint}/${eventId}`] = {
        uid: creatorUid,
        type: 'DEPOSIT',
        amount: amountSol,
        priceUsd: null,
        pnlSol: null,
        ts: now(),
    }
    await getAdminDb().ref().update(updates)
    return { ok: true }
}

export async function contributorDeposit(mint: string, amountSol: number, uid: string, opts?: { feeKeepPct?: number }) {
    const path = `/vaults/${mint}`
    const snap = await getAdminDb().ref(path).get()
    if (!snap.exists()) throw new Error('Vault not found')
    const v = snap.val()

    const updates: Record<string, any> = {}
    updates[`${path}/tvlSol`] = (v.tvlSol || 0) + amountSol
    updates[`${path}/updatedAt`] = now()

    const contribPath = `${path}/composition/contributors/${uid}`
    const prev = (v.composition && v.composition.contributors && v.composition.contributors[uid] && typeof v.composition.contributors[uid].sol === 'number') ? v.composition.contributors[uid].sol : 0
    const prevKeep = (v.composition && v.composition.contributors && v.composition.contributors[uid] && typeof v.composition.contributors[uid].keepPct === 'number') ? v.composition.contributors[uid].keepPct : undefined
    const keepPct = (typeof opts?.feeKeepPct === 'number') ? opts!.feeKeepPct : (typeof prevKeep === 'number' ? prevKeep : 0.6)
    updates[contribPath] = { uid, sol: prev + amountSol, keepPct }

    const eventId = uuidv4()
    updates[`/trades/${mint}/${eventId}`] = {
        uid,
        type: 'CONTRIBUTOR_DEPOSIT',
        amount: amountSol,
        priceUsd: null,
        pnlSol: null,
        ts: now(),
    }
    await getAdminDb().ref().update(updates)
    return { ok: true }
}

export async function openLong(uid: string, mint: string, collateralSol: number, leverageBps: number, opts?: { entryPriceUsd?: number, solPriceUsd?: number, rawFrontend?: any }) {
    let price: number | null = opts && typeof opts.entryPriceUsd === 'number' ? opts.entryPriceUsd : null
    let solPrice: number | null = opts && typeof opts.solPriceUsd === 'number' ? opts.solPriceUsd : null

    if (price == null || solPrice == null) {
        const priceSnap = await getAdminDb().ref(`/price_cache/${mint}`).get()
        const solSnap = await getAdminDb().ref(`/price_cache/WSOL_MINT`).get()
        if (price == null) price = priceSnap.exists() ? priceSnap.val().priceUsd : null
        if (solPrice == null) solPrice = solSnap.exists() ? solSnap.val().priceUsd : null
    }
    if (!price || !solPrice) throw new Error('prices unavailable')

    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        console.error(TAG, 'invalid token price from cache', { mint, price })
        throw new Error('invalid_price')
    }
    if (typeof solPrice !== 'number' || !Number.isFinite(solPrice) || solPrice <= 0) {
        console.error(TAG, 'invalid sol price from cache', { solPrice })
        throw new Error('invalid_sol_price')
    }
    const borrowSol = math.computeBorrowSol(collateralSol, leverageBps)
    const sizeToken = math.computeSizeToken(collateralSol, borrowSol, solPrice, price)

    if (!Number.isFinite(sizeToken) || sizeToken <= 0 || sizeToken > 1e9) {
        console.error(TAG, 'computed invalid sizeToken', { collateralSol, borrowSol, solPrice, price, sizeToken })
        throw new Error('invalid_size_computed')
    }
    const posId = uuidv4()
    const entryPriceUsd = price
    const entryTs = now()
    const interestAprBps = 1000

    const position = {
        side: 'LONG',
        collateralSol,
        borrowSol,
        sizeToken,
        entryPriceUsd,
        entryTs,
        debtAprBps: interestAprBps,
        status: 'OPEN',
        lastMarkUsd: price,
        unrealizedPnlSol: 0,
    }
    const borrowUsd = borrowSol * solPrice

    const vaultRef = getAdminDb().ref(`/vaults/${mint}`)
    const txResult = await vaultRef.transaction((v: any) => {
        if (v == null) return v
        const tvlSol = v.tvlSol || 0
        const prevBorrows = v.totalBorrowsSol || 0
        const available = tvlSol - prevBorrows
        if (available < borrowSol) {
            return
        }
        v.totalBorrowsSol = prevBorrows + borrowSol
        v.tvlSol = tvlSol - borrowSol
        if (typeof v.tvlUsd === 'number') {
            v.tvlUsd = Math.max(0, (v.tvlUsd || 0) - borrowUsd)
        }
        if (typeof v.tvl === 'number') {
            v.tvl = Math.max(0, (v.tvl || 0) - borrowUsd)
        }
        v.updatedAt = now()
        return v
    }, undefined, false)

    if (!txResult.committed) {
        throw new Error('insufficient vault capital')
    }

    const tradeId = uuidv4()

    try {
        const notionalUsd = entryPriceUsd * sizeToken
        const priceSol = solPrice
        const vaultParamsSnap = await getAdminDb().ref(`/vaults/${mint}/params`).get()
        const vaultParams = vaultParamsSnap.exists() ? vaultParamsSnap.val() : {}
        const feeBps = typeof vaultParams.openFeeBps === 'number' ? vaultParams.openFeeBps : 10
        const vaultSharePct = typeof vaultParams.vaultSharePct === 'number' ? vaultParams.vaultSharePct : 0.7
        const ownerKeepPct = typeof vaultParams.ownerKeepPct === 'number' ? vaultParams.ownerKeepPct : 0.6

        const feeBreak = calculateFeesUsdToSol(notionalUsd, feeBps, priceSol, vaultSharePct, { minFeeUsd: 0.01 })

        const composition = await loadVaultComposition(mint)
        const distrib = distributeFeeProRataSol(feeBreak.feeSol, composition, ownerKeepPct, ownerKeepPct)

        const balanceRef = getAdminDb().ref(`/users/${uid}/balance`)
        const feeSol = feeBreak.feeSol

        try {
            const balSnap = await balanceRef.get()
            const balVal = balSnap.exists() ? balSnap.val() : null
            console.info(TAG, 'fee collection attempt', { uid, feeSol, balanceBefore: balVal })
        } catch (readErr) {
            console.warn(TAG, 'failed to read balance before fee tx', readErr)
        }

        const snapAfter = await balanceRef.get()
        const balValAfter = snapAfter.exists() ? snapAfter.val() : null
        const balNumAfter = coerceNum(balValAfter)

        if (!Number.isFinite(balNumAfter) || balNumAfter < feeSol) {
            throw new Error('insufficient_balance_for_fee')
        }

        const txRes = await transactionWithReadGuard(balanceRef, (cur: number) => {
            if (cur < feeSol) return undefined
            return cur - feeSol
        }, { attempts: 6, backoffMs: 50, tag: 'fee_collection' })

        if (!txRes || !(txRes as any).committed) {
            throw new Error('insufficient_balance_for_fee')
        }

        const db = getAdminDb()
        if (distrib.creatorSol > 0) {
            const creatorRef = db.ref(`/vaults/${mint}/feesForCreator`)
            await creatorRef.transaction((curr: any) => {
                const cur = coerceNum(curr)
                return cur + distrib.creatorSol
            })
        }

        for (const c of distrib.contributors) {
            const contribPath = `/vaults/${mint}/composition/contributors/${c.uid}/claimable`
            const contribRef = db.ref(contribPath)
            await contribRef.transaction((curr: any) => {
                const cur = coerceNum(curr)
                return cur + (c.sol || 0)
            })
        }

        const platformRef = db.ref(`/platform/treasury/fees`)
        await platformRef.transaction((curr: any) => {
            const cur = coerceNum(curr)
            return cur + distrib.platformSol
        })

        const feeId = uuidv4()
        await db.ref(`/fees/${feeId}`).set({
            tradeId,
            event: 'OPEN',
            uid,
            mint,
            notionalUsd,
            feeUsd: feeBreak.feeUsd,
            feeSol: feeBreak.feeSol,
            distrib,
            usedSolPrice: feeBreak.usedSolPrice,
            ts: Date.now(),
            status: 'confirmed'
        })
    } catch (feeErr) {
        try {
            await vaultRef.transaction((v: any) => {
                if (v == null) return v
                v.totalBorrowsSol = Math.max(0, (v.totalBorrowsSol || 0) - borrowSol)
                v.tvlSol = (v.tvlSol || 0) + borrowSol
                if (typeof v.tvlUsd === 'number') v.tvlUsd = Math.max(0, (v.tvlUsd || 0) + borrowUsd)
                if (typeof v.tvl === 'number') v.tvl = Math.max(0, (v.tvl || 0) + borrowUsd)
                v.updatedAt = now()
                return v
            })
        } catch (revertErr) {
            console.error('Failed to revert vault after fee error', revertErr)
        }
        throw feeErr
    }

    const updates: Record<string, any> = {}
    updates[`/positions/${uid}/${mint}/${posId}`] = position

    const totalSol = (collateralSol || 0) + (borrowSol || 0)
    updates[`/trades/${mint}/${tradeId}`] = {
        uid,
        type: `OPEN ${position.side}`,
        posId,
        collateralSol,
        borrowedSol: borrowSol,
        totalSol,
        amount: collateralSol,
        priceUsd: entryPriceUsd,
        pnlSol: null,
        ts: now(),
        rawFrontend: opts && opts.rawFrontend ? opts.rawFrontend : null,
    }

    await getAdminDb().ref().update(updates)
    return { ok: true, posId, position }
}

export default { createVault, creatorDeposit, contributorDeposit, openLong }
