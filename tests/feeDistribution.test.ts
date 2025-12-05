import { describe, expect, it } from 'vitest';
import { distributeFeeProRata } from '../utils/fees';

describe('distributeFeeProRata', () => {
    it('allocates fees per example: creator 30k, contributor 20k', () => {
        // Use lamports scaled from USD example: we only need proportions, so lamports numbers proportional to USD
        const creatorLamports = 30000; // represent $30k
        const contributorLamports = 20000; // represent $20k
        const composition = {
            creator: { uid: 'creator', lamports: creatorLamports },
            contributors: [{ uid: 'contrib1', lamports: contributorLamports }],
        };

        const totalFee = 1_000_000; // fee in lamports (example)

        const res = distributeFeeProRata(totalFee, composition, 0.6, 0.6);

        // creator share = 30000 / 50000 = 0.6 -> ownerPortion = 600000
        // creatorKeep = floor(600000 * 0.6) = 360000
        expect(res.creatorLamports).toBe(360000);

        // contributor ownerPortion = 400000 -> keep = 240000
        const contrib = res.contributors.find(c => c.uid === 'contrib1');
        expect(contrib).toBeTruthy();
        expect(contrib!.lamports).toBe(240000);

        // platform gets the platform portions: 240k + 160k = 400k
        expect(res.platformLamports).toBe(400000);

        // allocated sum equals total fee
        expect(res.allocatedSum).toBe(totalFee);
    });

    it('puts all to platform when total capital is zero', () => {
        const composition = { creator: null, contributors: [] };
        const res = distributeFeeProRata(1000, composition, 0.6, 0.6);
        expect(res.platformLamports).toBe(1000);
        expect(res.creatorLamports).toBe(0);
        expect(res.contributors.length).toBe(0);
        expect(res.allocatedSum).toBe(1000);
    });

    it('handles small totalFee with remainder allocated to platform', () => {
        const composition = { creator: { uid: 'c', lamports: 1 }, contributors: [{ uid: 'd', lamports: 1 }] };
        const res = distributeFeeProRata(3, composition, 0.6, 0.6);
        // totalCapital = 2, ownerPortions floor((3 * 1)/2) = floor(1.5) = 1 each => allocatedPortionSum = 2, remainder =1 to platform
        // each ownerKeep = floor(1 * 0.6) = 0
        expect(res.creatorLamports).toBe(0);
        expect(res.contributors[0].lamports).toBe(0);
        expect(res.platformLamports).toBe(3);
        expect(res.allocatedSum).toBe(3);
    });
});
