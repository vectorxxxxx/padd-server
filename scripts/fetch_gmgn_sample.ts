import fs from 'fs';
import path from 'path';
import { gmgnService } from '../gmgnService';

(async () => {
    try {
        console.log('[script] Fetching GMGN sample...');
        const json = await gmgnService.testFetch();
        const outPath = path.resolve(process.cwd(), 'gmgn_sample.json');
        fs.writeFileSync(outPath, JSON.stringify(json, null, 2), 'utf-8');
        console.log('[script] Wrote sample to', outPath);
    } catch (err) {
        console.error('[script] Error fetching GMGN sample:', err);
        process.exitCode = 1;
    }
})();
