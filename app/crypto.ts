import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import * as dotenv from "dotenv";

dotenv.config();

export class CryptoManager {
  async deriveApiKeys(
    privateKey: string,
    options?: { funderAddress?: string | null; signatureType?: number | null }
  ) {
    const host = "https://clob.polymarket.com";
    const chainId = 137; // Polygon
    
    // Ensure the private key has the '0x' prefix
    const formattedPK = privateKey.startsWith("0x") ? (privateKey as `0x${string}`) : (`0x${privateKey}` as `0x${string}`);
    const account = privateKeyToAccount(formattedPK);
    
    // Create a viem WalletClient which the SDK expects
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http()
    });
    
    // Initializing client with the WalletClient
    // The cast to 'any' is needed because of internal SDK type complexities
    const signatureType = options?.signatureType ?? undefined;
    const funderAddress = options?.funderAddress || undefined;
    const client = new ClobClient(host, chainId, walletClient as any, undefined, signatureType as any, funderAddress);
    
    try {
      const creds = await client.createOrDeriveApiKey();
      return creds;
    } catch (error) {
      console.error("Error deriving API keys.");
      throw error;
    }
  }
}
