// Server-local copy of padd-ui/engine/engine.ts with imports adjusted to server/lib
import { v4 as uuidv4 } from 'uuid'
import { coerceNum, transactionWithReadGuard } from './balanceTx'
import { distributeFeeProRataSol, loadVaultComposition } from './fees'
import { getAdminDb } from './firebaseAdmin'
import * as math from './math'

const TAG = '[ENGINE]'

function now() {
    return Date.now()
}

export async function createVault(mint: string, creatorUid: string, params: any, name?: string, currency?: string) {
    // Create a unique canonical vaultId for the vault and write the
    // canonical record under `/vaults/<vaultId>`. Do NOT write the
    // `/vaultsByMint/<mint>` mapping here — mapping writes were removed
    // to avoid populating the legacy lookup path. To remain
    // backwards-compatible with any callers that expect `/vaults/<mint>`,
    // legacy behavior is intentionally not created here; callers should
    // resolve via canonical `vaultId` or other explicit lookups.
    const db = getAdminDb()
    // No legacy `/vaults/<mint>` creation: we create a canonical `/vaults/<vaultId>` record
    // and a mapping at `/vaultsByMint/<mint>/<vaultId> = true`. Do not write legacy keys.

    const vaultId = uuidv4()
    const vaultPath = `/vaults/${vaultId}`
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

    // Prepare multi-path update: only write the canonical vault record.
    const updates: Record<string, any> = {}
    updates[vaultPath] = data
    await db.ref().update(updates)
    console.info(TAG, 'createVault', { tokenMint: mint, vaultId, creatorUid, name, currency })
    return { ok: true, vault: data, vaultId }
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

    // Determine token mint from the vault keyed by `mint` (caller passes vaultId here).
    // If no vault exists at that key, treat `mint` as the token mint (legacy behavior).
    const db = getAdminDb()
    let tokenMint: string = mint
    try {
        const vaultSnap = await db.ref(`/vaults/${mint}`).get()
        if (vaultSnap.exists()) {
            const vaultVal = vaultSnap.val()
            if (vaultVal && vaultVal.tokenMint) tokenMint = vaultVal.tokenMint
        }
    } catch (e) {
        // ignore and fall back to treating `mint` as token mint
    }

    if (price == null || solPrice == null) {
        const priceSnap = await db.ref(`/price_cache/${tokenMint}`).get()
        const solSnap = await db.ref(`/price_cache/WSOL_MINT`).get()
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
    try {
        const beforeSnap = await vaultRef.get()
        const beforeVal = beforeSnap.exists() ? beforeSnap.val() : null
        try { console.info(TAG, 'vault before borrow tx', JSON.stringify({ mint, beforeVal })) } catch (e) { console.info(TAG, 'vault before borrow tx', { mint, beforeVal }) }
    } catch (e) {
        console.warn(TAG, 'failed to read vault before tx', { mint, err: e })
    }
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
    try {
        const afterSnap = await vaultRef.get()
        const afterVal = afterSnap.exists() ? afterSnap.val() : null
        try { console.info(TAG, 'vault after borrow tx', JSON.stringify({ mint, committed: txResult?.committed, afterVal })) } catch (e) { console.info(TAG, 'vault after borrow tx', { mint, committed: txResult?.committed, afterVal }) }
    } catch (e) {
        console.warn(TAG, 'failed to read vault after tx', { mint, err: e })
    }

    if (!txResult.committed) {
        throw new Error('insufficient vault capital')
    }

    const tradeId = uuidv4()

    // Declare feeBreak/distrib in outer scope so they are available after the try
    let feeBreak: any = null
    let distrib: any = null

    try {
        const notionalUsd = entryPriceUsd * sizeToken
        const priceSol = solPrice
        const vaultParamsSnap = await getAdminDb().ref(`/vaults/${mint}/params`).get()
        const vaultParams = vaultParamsSnap.exists() ? vaultParamsSnap.val() : {}
        const feeBps = typeof vaultParams.openFeeBps === 'number' ? vaultParams.openFeeBps : 10
        const vaultSharePct = typeof vaultParams.vaultSharePct === 'number' ? vaultParams.vaultSharePct : 0.7
        const ownerKeepPct = typeof vaultParams.ownerKeepPct === 'number' ? vaultParams.ownerKeepPct : 0.6

        // Charge trader 10% of their collateral (in SOL) as the total fee.
        // feeSol = collateralSol * 0.10
        const feeSol = (collateralSol || 0) * 0.10
        const feeUsd = feeSol * priceSol
        const feeVaultSol = feeSol * vaultSharePct
        const feePlatformSol = feeSol - feeVaultSol
        feeBreak = {
            notionalUsd,
            feeBps,
            feeUsd,
            feeSol,
            feeVaultSol,
            feePlatformSol,
            usedSolPrice: priceSol
        }

        let composition = await loadVaultComposition(tokenMint)
        // If composition is empty, fallback to using the vault's creatorUid
        // so the entire vault share is allocated to that creator automatically.
        let vaultCreatorUid: string | null = null
        if (!composition || (!composition.creator && !(composition.contributors && composition.contributors.length > 0))) {
            try {
                const vaultSnap = await getAdminDb().ref(`/vaults/${mint}`).get()
                if (vaultSnap.exists()) {
                    const vault = vaultSnap.val()
                    if (vault && vault.creatorUid) {
                        vaultCreatorUid = vault.creatorUid
                        // Use a nominal `sol` of 1 for the synthetic composition when needed
                        composition = { creator: { uid: vault.creatorUid, sol: 1 } }
                        console.info(TAG, 'fee distribution fallback used vault.creatorUid', { mint, creatorUid: vault.creatorUid })
                        try { console.info(TAG, 'distribution source (engine)', JSON.stringify({ mint, vaultCreatorUid: vault.creatorUid, composition })) } catch (e) { console.info(TAG, 'distribution source (engine)', { mint, vaultCreatorUid: vault.creatorUid, composition }) }
                    }
                }
            } catch (fbErr) {
                console.warn(TAG, 'failed to fetch vault for composition fallback', { mint, err: fbErr })
            }
        }
        // Log composition just before distribution to help debug creator allocation
        try { console.info(TAG, 'distribution composition (engine) before distributeFeeProRataSol', JSON.stringify({ mint, composition, vaultCreatorUid })) } catch (e) { console.info(TAG, 'distribution composition (engine) before distributeFeeProRataSol', { mint, composition, vaultCreatorUid }) }
        // If we have an authoritative vault creator, allocate the vault share directly to them
        let ownerDistrib: any = null
        if (vaultCreatorUid) {
            ownerDistrib = {
                totalFeeSol: feeBreak.feeVaultSol,
                platformSol: 0,
                creatorSol: feeBreak.feeVaultSol,
                contributors: [],
                allocatedSum: feeBreak.feeVaultSol
            }
            console.info(TAG, 'authoritative allocation used (engine)', { mint, vaultCreatorUid, creatorSol: ownerDistrib.creatorSol })
        } else {
            // Distribute only the vault's share among creator/contributors (owner keep = 100%)
            ownerDistrib = distributeFeeProRataSol(feeBreak.feeVaultSol, composition, 1.0, 1.0)
        }
        // Combine platform amounts: platform gets feePlatformSol plus any platform portion from ownerDistrib
        distrib = {
            totalFeeSol: feeBreak.feeSol,
            platformSol: (feeBreak.feePlatformSol || 0) + (ownerDistrib.platformSol || 0),
            creatorSol: ownerDistrib.creatorSol || 0,
            contributors: ownerDistrib.contributors || [],
            allocatedSum: (feeBreak.feeSol)
        }

        const balanceRef = getAdminDb().ref(`/users/${uid}/balance`)
        const feeToCollect = feeBreak.feeSol
        const totalToDeduct = collateralSol + feeToCollect

        try {
            const balSnap = await balanceRef.get()
            const balVal = balSnap.exists() ? balSnap.val() : null
            console.info(TAG, 'balance deduction attempt', { uid, collateralSol, feeToCollect, totalToDeduct, balanceBefore: balVal })
        } catch (readErr) {
            console.warn(TAG, 'failed to read balance before deduction tx', readErr)
        }

        // NOTE: client will perform balance validation. Rely on the atomic
        // transaction below to fail if the balance is insufficient instead
        // of performing a pre-check here which can introduce race conditions.

        // Debug: log fee breakdown and a fresh balance read so we can inspect
        // exact values leading to any `insufficient_balance` errors.
        try {
            // Stringify to avoid logger truncation in hosting platforms
            try { console.info(TAG, 'feeBreak', JSON.stringify(feeBreak)) } catch (sErr) { console.info(TAG, 'feeBreak', feeBreak) }
            const curSnap = await balanceRef.get()
            const curVal = curSnap.exists() ? curSnap.val() : null
            try { console.info(TAG, 'balance before deduction tx (fresh read)', JSON.stringify({ uid, totalToDeduct, balance: curVal })) } catch (sErr) { console.info(TAG, 'balance before deduction tx (fresh read)', { uid, totalToDeduct, balance: curVal }) }
        } catch (dbgErr) {
            console.warn(TAG, 'failed to perform debug balance read', dbgErr)
        }

        const txRes = await transactionWithReadGuard(balanceRef, (cur: number) => {
            if (cur < totalToDeduct) return undefined
            return cur - totalToDeduct
        }, { attempts: 6, backoffMs: 50, tag: 'collateral_and_fee_deduction' })

        if (!txRes || !(txRes as any).committed) {
            // Read current balance to include in the error for debugging/client handling
            let curVal: any = null
            try {
                const curSnap = await balanceRef.get()
                curVal = curSnap.exists() ? curSnap.val() : null
            } catch { /* ignore */ }

            try { console.warn(TAG, 'collateral+fee deduction failed - current balance', JSON.stringify({ uid, curVal, required: totalToDeduct })) } catch (e) { console.warn(TAG, 'collateral+fee deduction failed - current balance', { uid, curVal, required: totalToDeduct }) }

            const err: any = new Error('insufficient_balance')
            err.feeBreak = feeBreak
            err.currentBalance = curVal
            err.required = totalToDeduct
            throw err
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
    // Return fee breakdown and distribution so clients can display/record fees
    return { ok: true, posId, position, feeBreak, distrib }
}

export async function closeLong(uid: string, vaultId: string, posId: string, opts?: { liquidated?: boolean, currentValueSol?: number, solPriceUsd?: number, markUsd?: number }) {
    const db = getAdminDb()
    const liquidated = opts?.liquidated ?? false

    // 1. Fetch position
    const posPath = `/positions/${uid}/${vaultId}/${posId}`
    const posSnap = await db.ref(posPath).get()
    if (!posSnap.exists()) {
        throw new Error('position_not_found')
    }
    const position = posSnap.val()
    if (position.status !== 'OPEN') {
        throw new Error('position_not_open')
    }

    // 2. Validate currentValueSol from frontend (required)
    const currentValueSol = opts?.currentValueSol
    if (typeof currentValueSol !== 'number' || !Number.isFinite(currentValueSol) || currentValueSol < 0) {
        throw new Error('currentValueSol_required')
    }

    // Get vault for reference
    const vaultSnap = await db.ref(`/vaults/${vaultId}`).get()
    if (!vaultSnap.exists()) {
        throw new Error('vault_not_found')
    }

    const { collateralSol, borrowSol, sizeToken, entryPriceUsd } = position
    const notionalSol = collateralSol + borrowSol  // Original position size in SOL

    // 3. Return borrowed SOL to vault first
    const vaultRef = db.ref(`/vaults/${vaultId}`)
    await vaultRef.transaction((v: any) => {
        if (v == null) return v
        // Add borrow back to TVL
        v.tvlSol = (v.tvlSol || 0) + borrowSol
        // Subtract from totalBorrowsSol
        v.totalBorrowsSol = Math.max(0, (v.totalBorrowsSol || 0) - borrowSol)
        v.updatedAt = now()
        return v
    })

    // 4. Calculate PnL: currentValueSol - notionalSol (what was originally put in)
    const pnlSol = currentValueSol - notionalSol

    console.info(TAG, 'closeLong calculation', {
        uid, vaultId, posId,
        currentValueSol, notionalSol, collateralSol, borrowSol,
        pnlSol
    })

    // 5. Calculate fees (only from positive PnL)
    let creatorFeeSol = 0
    let platformFeeSol = 0
    let userPayoutSol = currentValueSol  // Start with full current value

    if (pnlSol > 0) {
        // 10% of PnL goes to creator
        creatorFeeSol = pnlSol * 0.10
        // 5% of PnL goes to platform
        platformFeeSol = pnlSol * 0.05
        // User gets currentValue minus fees
        userPayoutSol = currentValueSol - creatorFeeSol - platformFeeSol
    }
    // If pnlSol <= 0, no fees taken, user just gets currentValueSol (could be less than collateral)

    console.info(TAG, 'closeLong fees', {
        pnlSol, creatorFeeSol, platformFeeSol, userPayoutSol,
        pnlPositive: pnlSol > 0
    })

    // 6. Add creator fee to vault's feesForCreator
    if (creatorFeeSol > 0) {
        const creatorFeeRef = db.ref(`/vaults/${vaultId}/feesForCreator`)
        await creatorFeeRef.transaction((curr: any) => {
            const cur = coerceNum(curr)
            return cur + creatorFeeSol
        })
    }

    // 7. Add platform fee to treasury
    if (platformFeeSol > 0) {
        const platformRef = db.ref(`/platform/treasury/fees`)
        await platformRef.transaction((curr: any) => {
            const cur = coerceNum(curr)
            return cur + platformFeeSol
        })
    }

    // 8. Credit user balance with payout (currentValue minus fees)
    if (userPayoutSol > 0) {
        const balanceRef = db.ref(`/users/${uid}/balance`)
        await balanceRef.transaction((curr: any) => {
            const cur = coerceNum(curr)
            return cur + userPayoutSol
        })
    }

    // 9. Update position status to CLOSED
    await db.ref(posPath).update({
        status: 'CLOSED',
        closedAt: now(),
        closeMarkUsd: opts?.markUsd ?? null,
        closeSolPriceUsd: opts?.solPriceUsd ?? null,
        currentValueSol,
        realizedPnlSol: pnlSol,
        liquidated
    })

    // 10. Record trade
    const tradeId = uuidv4()
    await db.ref(`/trades/${vaultId}/${tradeId}`).set({
        uid,
        type: liquidated ? 'LIQUIDATE' : 'CLOSE LONG',
        posId,
        collateralSol,
        borrowedSol: borrowSol,
        sizeToken,
        entryPriceUsd,
        currentValueSol,
        closeMarkUsd: opts?.markUsd ?? null,
        closeSolPriceUsd: opts?.solPriceUsd ?? null,
        pnlSol,
        creatorFeeSol,
        platformFeeSol,
        userPayoutSol,
        ts: now()
    })

    // 11. Record fee entry
    const feeId = uuidv4()
    await db.ref(`/fees/${feeId}`).set({
        tradeId,
        event: liquidated ? 'LIQUIDATE' : 'CLOSE',
        uid,
        vaultId,
        pnlSol,
        creatorFeeSol,
        platformFeeSol,
        userPayoutSol,
        usedSolPrice: opts?.solPriceUsd ?? null,
        ts: now(),
        status: 'confirmed'
    })

    console.info(TAG, 'closeLong completed', {
        uid, vaultId, posId, currentValueSol, pnlSol, creatorFeeSol, platformFeeSol, userPayoutSol
    })

    return {
        ok: true,
        posId,
        currentValueSol,
        pnlSol,
        creatorFeeSol,
        platformFeeSol,
        userPayoutSol
    }
}

export default { createVault, creatorDeposit, contributorDeposit, openLong, closeLong }
