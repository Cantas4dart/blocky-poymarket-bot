import { ClobClient, AssetType, Side, UserOrder } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

export class PolyMarketAPI {
  private client: ClobClient | null = null;
  private readonly dataApiUrl = "https://data-api.polymarket.com";

  constructor(creds: { key: string; secret: string; passphrase: string }, privateKey?: string) {
    this.initClient(creds, privateKey);
  }

  private initClient(creds: { key: string; secret: string; passphrase: string }, privateKey?: string) {
    const host = "https://clob.polymarket.com";
    const chainId = 137;
    
    let signer = undefined;
    if (privateKey) {
      const formattedPK = privateKey.startsWith("0x") ? (privateKey as `0x${string}`) : (`0x${privateKey}` as `0x${string}`);
      const account = privateKeyToAccount(formattedPK);
      signer = createWalletClient({
        account,
        chain: polygon,
        transport: http()
      });
    }

    this.client = new ClobClient(host, chainId, signer as any, creds);
  }

  async getBalance() {
    if (!this.client) throw new Error("Client not initialized");
    return await this.client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
  }

  async getPositions(userAddress: string) {
    const url = `${this.dataApiUrl}/positions?user=${userAddress}`;
    const response = await axios.get(url);
    return response.data;
  }

  async placeLimitOrder(tokenID: string, side: "BUY" | "SELL", price: number, size: number) {
    if (!this.client) throw new Error("Client not initialized");
    
    console.log(`[EXEC] Placing ${side} order for ${tokenID}: ${size} shares @ ${price}`);
    
    try {
      // Corrected interface for placing orders in TypeScript SDK: UserOrder
      const order: UserOrder = {
        tokenID: tokenID,
        price: price,
        size: size,
        side: side === "BUY" ? Side.BUY : Side.SELL,
      };
      
      const res = await this.client.createOrder(order);
      console.log(`[EXEC] Order Placed Successfully: ${res.orderID}`);
      return res;
    } catch (e: any) {
      console.error(`[EXEC] Order Failed: ${e.message}`);
      throw e;
    }
  }

  async getMarket(conditionId: string) {
    const url = `https://gamma-api.polymarket.com/markets?conditionId=${conditionId}`;
    const res = await axios.get(url);
    return res.data[0];
  }
}