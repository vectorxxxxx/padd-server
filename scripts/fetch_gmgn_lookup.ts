import fs from 'fs';
import path from 'path';
import { gmgnService } from '../gmgnService';

(async () => {
    try {
        console.log('[script] Fetching GMGN v3 lookup sample for query="bonk"...');
        const coins = await gmgnService.lookup('bonk');
        const outPath = path.resolve(process.cwd(), 'gmgn_lookup_sample.json');
        fs.writeFileSync(outPath, JSON.stringify(coins, null, 2), 'utf-8');
        console.log('[script] Wrote lookup sample to', outPath);
    } catch (err) {
        console.error('[script] Error fetching GMGN lookup sample:', err);
        process.exitCode = 1;
    }
})();
