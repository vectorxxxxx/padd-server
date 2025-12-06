import { Codex } from "@codex-data/sdk";

if (!process.env.CODEX_API_KEY) {
    // do not throw at import time; allow runtime code to handle missing key
    console.warn('Warning: CODEX_API_KEY is not set. Codex SDK will be constructed with undefined key.');
}

export const sdk = new Codex(process.env.CODEX_API_KEY as string);

// Example usage (uncomment to test):
// sdk.queries.token({ input: { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", networkId: 56 } }).then(console.log).catch(console.error);
