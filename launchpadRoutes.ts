import { Keypair } from '@solana/web3.js';
import express from 'express';
import { uploadToBundlr } from './services/bundlrService';
import { parseDataUrl } from './utils/dataUrl';
import { log } from './vite';

const router = express.Router();

// Environment configuration
const isDev = process.env.NODE_ENV !== 'production';

// SLAB Platform Configuration - deployed on devnet
const SLAB_PLATFORM_CONFIG_ID = '9s82BCAuWCtXub1MytzfH93LG2cRM41YEF8CYTZpc8w5';

/**
 * POST /api/launchpad/metadata
 * Host token image (if necessary) and metadata JSON on Arweave via Bundlr
 */
router.post('/metadata', async (req, res) => {
    try {
        const {
            name,
            symbol,
            description = '',
            imageUrl,
            imageDataUrl,
            imageContentType,
            externalUrl,
            attributes,
        } = req.body ?? {};

        if (!name || typeof name !== 'string') {
            return res.status(400).json({ success: false, error: 'Token name is required' });
        }

        if (!symbol || typeof symbol !== 'string') {
            return res.status(400).json({ success: false, error: 'Token symbol is required' });
        }

        let finalImageUrl: string | undefined = typeof imageUrl === 'string' ? imageUrl : undefined;
        let finalImageContentType: string | undefined =
            typeof imageContentType === 'string' && imageContentType.length > 0
                ? imageContentType
                : undefined;
        const appendExtensionQuery = (url: string, contentType: string | undefined) => {
            if (!url || !contentType) return url;
            const normalized = contentType.toLowerCase();
            const mimeToExt: Record<string, string> = {
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/jpg': 'jpg',
                'image/gif': 'gif',
                'image/webp': 'webp',
                'image/svg+xml': 'svg',
                'image/avif': 'avif',
                'image/bmp': 'bmp',
                'image/tiff': 'tiff',
                'application/json': 'json',
            };
            const ext = mimeToExt[normalized];
            if (!ext) return url;
            return url.includes('?') ? `${url}&ext=${ext}` : `${url}?ext=${ext}`;
        };

        let uploadedImageArweaveUrl: string | undefined;

        if (!finalImageUrl) {
            if (typeof imageDataUrl !== 'string' || imageDataUrl.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Either imageUrl or imageDataUrl must be provided',
                });
            }

            const parsed = parseDataUrl(imageDataUrl);
            if (!parsed) {
                return res.status(400).json({
                    success: false,
                    error: 'Failed to parse provided image data',
                });
            }

            const imageUpload = await uploadToBundlr(parsed.buffer, parsed.mimeType);
            finalImageUrl = appendExtensionQuery(imageUpload.gatewayUrl, parsed.mimeType);
            uploadedImageArweaveUrl = appendExtensionQuery(imageUpload.arweaveUrl, parsed.mimeType);
            finalImageContentType = parsed.mimeType;

            log(
                `[Launchpad] Hosted image on Arweave (tx: ${imageUpload.transactionId}) for ${symbol}`
            );
        }

        const finalDescription = typeof description === 'string' ? description : '';
        const finalExternalUrl =
            typeof externalUrl === 'string' && externalUrl.length > 0
                ? externalUrl
                : 'https://slab.trade';

        const normalizedAttributes =
            Array.isArray(attributes) && attributes.every((attr) => attr && typeof attr === 'object')
                ? attributes
                : [];

        const metadata = {
            name,
            symbol,
            description: finalDescription,
            image: finalImageUrl,
            external_url: finalExternalUrl,
            seller_fee_basis_points: 0,
            attributes: normalizedAttributes,
            properties: {
                files: finalImageUrl
                    ? [
                        {
                            uri: finalImageUrl,
                            type: finalImageContentType || 'image/png',
                        },
                    ]
                    : [],
                category: finalImageUrl ? 'image' : 'token',
            },
        };

        const metadataUpload = await uploadToBundlr(
            Buffer.from(JSON.stringify(metadata)),
            'application/json'
        );

        const metadataGatewayUrl = appendExtensionQuery(metadataUpload.gatewayUrl, 'application/json');
        const metadataArweaveUrl = appendExtensionQuery(metadataUpload.arweaveUrl, 'application/json');

        log(
            `[Launchpad] Hosted metadata on Arweave (tx: ${metadataUpload.transactionId}) for ${symbol}`
        );

        return res.json({
            success: true,
            metadataUri: metadataGatewayUrl,
            metadataArweaveUri: metadataArweaveUrl,
            imageUrl: finalImageUrl,
            imageArweaveUrl: uploadedImageArweaveUrl ?? finalImageUrl,
            metadata,
            imageContentType: finalImageContentType,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error uploading metadata';
        log(`[Launchpad] Metadata upload failed: ${message}`);
        console.error('[Launchpad] Metadata upload error:', error);
        return res.status(500).json({ success: false, error: message });
    }
});

/**
 * POST /api/launchpad/create
 * Prepare parameters for client-side Raydium SDK launchpad creation
 * Following the pattern from raydium-sdk-v2-demo/src/launchpad/createMint.ts
 */
router.post('/create', async (req, res) => {
    try {
        log('[Launchpad] Preparing parameters for client-side SDK...');

        const {
            name,
            symbol,
            uri,
            totalSupply = '1000000000000', // 1M tokens (1e12 with 6 decimals)
            tokensToSell = '500000000000', // Half supply (500k tokens)
            totalFundRaisingB = '5000000000', // 5 SOL graduation threshold
            migrateType = 'cpmm',
            decimals = 6,
            buyAmount = '100000000', // 0.1 SOL initial buy
            createOnly = false, // Allow initial buy by default
        } = req.body;

        // Validate required fields
        if (!name || !symbol || !uri) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: name, symbol, uri'
            });
        }

        const totalFundRaisingBLamports = Number(totalFundRaisingB);
        if (!Number.isFinite(totalFundRaisingBLamports) || totalFundRaisingBLamports <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Graduation threshold must be a positive numeric value'
            });
        }

        // Validate supply parameters (Raydium requirements)
        const totalSupplyNum = Number(totalSupply);
        const tokensToSellNum = Number(tokensToSell);

        console.log('[Raydium Debug] All parameters:', {
            totalSupply,
            tokensToSell,
            totalFundRaisingB,
            totalSupplyNum,
            tokensToSellNum,
            totalFundRaisingBLamports,
            buyAmount,
            createOnly,
            isSupplyValid: tokensToSellNum < totalSupplyNum
        });

        if (tokensToSellNum >= totalSupplyNum) {
            return res.status(400).json({
                success: false,
                error: `Total supply (${totalSupplyNum}) must be greater than tokens to sell (${tokensToSellNum})`
            });
        }

        if (totalSupplyNum < 10_000_000) {
            return res.status(400).json({
                success: false,
                error: 'Total supply must be at least 10,000,000 tokens'
            });
        }

        log(`[Launchpad] Validating params: ${JSON.stringify({
            name,
            symbol,
            totalSupply,
            tokensToSell,
            totalFundRaisingB,
            migrateType,
            decimals,
            buyAmount,
            createOnly
        })}`);

        // Generate new mint keypair for client
        const mintKeypair = Keypair.generate();

        log('[Launchpad] Returning parameters for client-side raydium.launchpad.createLaunchpad() call...');

        // Return parameters for client-side SDK usage (following createMint.ts pattern)
        return res.json({
            success: true,
            data: {
                // Parameters needed for client-side raydium.launchpad.createLaunchpad() call
                launchpadConfigId: SLAB_PLATFORM_CONFIG_ID,
                mint: {
                    publicKey: mintKeypair.publicKey.toString(),
                    secretKey: Array.from(mintKeypair.secretKey)
                },
                metadata: {
                    name: `${name} (SLAB)`,
                    symbol,
                    description: name,
                    uri: uri  // This is the metadata JSON URI, not image URI
                },
                supply: totalSupply,
                totalSellA: tokensToSell,
                totalFundRaisingB: totalFundRaisingB,
                buyAmount: buyAmount,
                createOnly: createOnly,
                cluster: isDev ? 'devnet' : 'mainnet',
                message: 'Parameters prepared for client-side Raydium SDK integration'
            }
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        log(`[Launchpad] Error preparing parameters: ${errorMessage}`);
        console.error('[Launchpad] Full error:', error);

        return res.status(500).json({
            success: false,
            error: errorMessage,
            details: isDev ? error : undefined
        });
    }
});

/**
 * GET /api/launchpad/config
 * Get SLAB platform configuration info
 */
router.get('/config', async (req, res) => {
    try {
        const config = {
            platformConfigId: SLAB_PLATFORM_CONFIG_ID,
            network: isDev ? 'devnet' : 'mainnet',
            cluster: isDev ? 'devnet' : 'mainnet',
            minFundraising: {
                lamports: "0", // No minimum - user can choose any amount
                sol: 0,
            },
            platform: {
                name: 'SLAB',
                website: 'https://slab.trade',
                logo: 'https://i.ibb.co/230s7Rw5/slablogo.png',
                description: 'Launch perpetual markets with custom bonding curves on Solana',
                feeRate: '0.1%',
                creatorFeeRate: '0%',
                graduationThreshold: '80 SOL'
            }
        };

        return res.json({
            success: true,
            config
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        log(`[Launchpad] Error getting config: ${errorMessage}`);

        return res.status(500).json({
            success: false,
            error: errorMessage
        });
    }
});

/**
 * POST /api/launchpad/validate
 * Validate launch parameters before submission (Updated for new API)
 */
router.post('/validate', async (req, res) => {
    try {
        const {
            name,
            symbol,
            uri,
            totalSupply,
            tokensToSell,
            fundraisingTarget,
            decimals = 6,
        } = req.body;

        const errors: string[] = [];

        // Validate required fields
        if (!name || name.trim().length < 2) {
            errors.push('Token name must be at least 2 characters long');
        }

        if (!symbol || symbol.trim().length < 2) {
            errors.push('Token symbol must be at least 2 characters long');
        }

        if (!uri || !uri.startsWith('http')) {
            errors.push('Valid metadata URI is required');
        }

        // Convert strings to numbers for validation
        const totalSupplyNum = Number(totalSupply) || 0;
        const tokensToSellNum = Number(tokensToSell) || 0;
        const fundraisingTargetNum = Number(fundraisingTarget) || 0;

        // Validate minimum supply
        if (totalSupplyNum < 10_000_000) {
            errors.push('Total supply must be at least 10,000,000 tokens');
        }

        // Validate supply is greater than tokens to sell (Raydium requirement)
        if (tokensToSellNum >= totalSupplyNum) {
            errors.push('Total supply must be greater than tokens to sell');
        }

        // Validate tokens to sell (minimum 20% of supply)
        const minTokensToSell = totalSupplyNum * 0.2;
        if (tokensToSellNum < minTokensToSell) {
            errors.push(`Tokens to sell must be at least 20% of total supply (${minTokensToSell.toLocaleString()})`);
        }

        // Validate fundraising target (must be greater than 0)
        if (fundraisingTargetNum <= 0) {
            errors.push('Fundraising target must be greater than 0');
        }

        // Validate decimals
        if (decimals < 0 || decimals > 9) {
            errors.push('Decimals must be between 0 and 9');
        }

        if (errors.length > 0) {
            return res.status(400).json({
                success: false,
                errors
            });
        }

        return res.json({
            success: true,
            message: 'Launch parameters are valid'
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        log(`[Launchpad] Error validating params: ${errorMessage}`);

        return res.status(500).json({
            success: false,
            error: errorMessage
        });
    }
});

export default router;
