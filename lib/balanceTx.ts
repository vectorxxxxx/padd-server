// Local copy of balanceTx utilities to keep server bundling self-contained
export function coerceNum(v: any): number {
    if (v == null) return 0
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
    }
    try {
        if (typeof v.value === 'number') return v.value
        if (typeof v.value === 'string') {
            const n = Number(v.value)
            return Number.isFinite(n) ? n : 0
        }
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
    } catch (e) {
        return 0
    }
}

export function coerceNumNullable(v: any): number | null {
    if (v == null) return null
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
        const n = Number(v)
        return Number.isFinite(n) ? n : null
    }
    try {
        if (typeof v.value === 'number') return v.value
        if (typeof v.value === 'string') {
            const n = Number(v.value)
            return Number.isFinite(n) ? n : null
        }
        const n = Number(v)
        return Number.isFinite(n) ? n : null
    } catch (e) {
        return null
    }
}

export type UpdateFn = (cur: number, readVal: number) => number | undefined

export async function transactionWithReadGuard(ref: any, updateFn: UpdateFn, opts?: { attempts?: number, backoffMs?: number, tag?: string }) {
    const attempts = opts?.attempts ?? 6
    const backoffMs = opts?.backoffMs ?? 50
    for (let attempt = 0; attempt < attempts; attempt++) {
        const snap = await ref.get()
        const readValRaw = snap.exists() ? snap.val() : null
        const readVal = coerceNum(readValRaw)

        const txRes = await ref.transaction((current: any) => {
            let cur: number | null = coerceNumNullable(current)
            if ((!Number.isFinite(cur as number)) && Number.isFinite(readVal)) {
                cur = readVal
            }
            if (!Number.isFinite(cur as number)) return undefined
            // ensure CAS guard
            if (Math.abs((cur as number) - readVal) > 1e-12) return undefined
            const out = updateFn(cur as number, readVal)
            return typeof out === 'number' ? out : undefined
        }, undefined, false)

        if (txRes && txRes.committed) {
            return txRes
        }

        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)))
    }
    return null
}
