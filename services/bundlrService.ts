import Bundlr from "@bundlr-network/client";
import BigNumber from "bignumber.js";
import bs58 from "bs58";

type BundlrClient = InstanceType<typeof Bundlr>;

const BUNDLR_CACHE: {
  client: BundlrClient | null;
  gatewayBase: string | null;
  gatewayDataSuffix: string;
} = {
  client: null,
  gatewayBase: null,
  gatewayDataSuffix: "",
};

function decodePrivateKey(secret: string): Uint8Array | string {
  const trimmed = secret.trim();

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as number[];
      return Uint8Array.from(parsed);
    } catch (error) {
      console.warn("[Bundlr] Failed to parse JSON formatted key, falling back to raw string.", error);
    }
  }

  try {
    return bs58.decode(trimmed);
  } catch {
    return trimmed;
  }
}

async function ensureClient(): Promise<BundlrClient> {
  if (BUNDLR_CACHE.client) {
    return BUNDLR_CACHE.client;
  }

  const { BUNDLR_NODE_URL, BUNDLR_CURRENCY, BUNDLR_PRIVATE_KEY, BUNDLR_PROVIDER_URL } = process.env;

  if (!BUNDLR_PRIVATE_KEY) {
    throw new Error("BUNDLR_PRIVATE_KEY is not configured");
  }

  const nodeUrl = BUNDLR_NODE_URL || "https://devnet.bundlr.network";
  const currency = BUNDLR_CURRENCY || "solana";
  const providerUrl = BUNDLR_PROVIDER_URL || "https://api.devnet.solana.com";

  const client = new Bundlr(nodeUrl, currency, decodePrivateKey(BUNDLR_PRIVATE_KEY), {
    providerUrl,
  });

  await client.ready();
  BUNDLR_CACHE.client = client;

  const explicitGateway = process.env.BUNDLR_GATEWAY_BASE_URL?.trim();
  if (explicitGateway) {
    BUNDLR_CACHE.gatewayBase = explicitGateway.replace(/\/$/, "");
    BUNDLR_CACHE.gatewayDataSuffix = "";
  } else if (nodeUrl.includes("devnet.bundlr.network")) {
    BUNDLR_CACHE.gatewayBase = "https://devnet.bundlr.network/tx";
    BUNDLR_CACHE.gatewayDataSuffix = "/data";
  } else {
    BUNDLR_CACHE.gatewayBase = "https://arweave.net";
    BUNDLR_CACHE.gatewayDataSuffix = "";
  }

  return client;
}

async function ensureFunds(client: BundlrClient, price: BigNumber) {
  const loadedBalance = await client.getLoadedBalance();

  if (loadedBalance.gte(price)) {
    return;
  }

  const delta = price.minus(loadedBalance).multipliedBy(1.1).integerValue(BigNumber.ROUND_CEIL);
  if (delta.lte(0)) {
    return;
  }

  console.log(
    `[Bundlr] Funding node with ${client.utils.fromAtomic(delta)} ${client.currency} to cover upload`
  );
  await client.fund(delta);
}

export interface UploadResult {
  arweaveUrl: string;
  transactionId: string;
  gatewayUrl: string;
  contentType: string;
}

export async function uploadToBundlr(
  data: Buffer,
  contentType: string,
  tags: Array<{ name: string; value: string }> = [],
  attempt = 0
): Promise<UploadResult> {
  try {
    const client = await ensureClient();
    const price = await client.getPrice(data.length);

    console.log(
      `[Bundlr] Uploading ${contentType} (${data.length} bytes) costing ${client.utils.fromAtomic(
        price
      )} ${client.currency}`
    );

    await ensureFunds(client, price);

    const receipt = await client.upload(data, {
      tags: [{ name: "Content-Type", value: contentType }, ...tags],
    });

    const base = (BUNDLR_CACHE.gatewayBase || "https://arweave.net").replace(/\/$/, "");
    const suffix = BUNDLR_CACHE.gatewayDataSuffix || "";
    const gatewayUrl = `${base}/${receipt.id}${suffix}`;

    return {
      arweaveUrl: `https://arweave.net/${receipt.id}`,
      gatewayUrl,
      transactionId: receipt.id,
      contentType,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetry =
      attempt === 0 &&
      /block height exceeded|expired/i.test(message);

    if (shouldRetry) {
      console.warn("[Bundlr] Upload failed due to expired blockhash. Resetting client and retrying once...");
      BUNDLR_CACHE.client = null;
      BUNDLR_CACHE.gatewayBase = null;
      BUNDLR_CACHE.gatewayDataSuffix = "";
      return uploadToBundlr(data, contentType, tags, attempt + 1);
    }

    throw error;
  }
}

