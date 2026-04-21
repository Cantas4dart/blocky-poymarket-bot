import { ClobClient, AssetType, Side, UserOrder } from "@polymarket/clob-client";
import { createWalletClient, http, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

export class PolyMarketAPI {
  private client: ClobClient | null = null;
  private readonly dataApiUrl = "https://data-api.polymarket.com";
  private privateKey?: string;
  private readonly usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  private readonly conditionalTokensAddress = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

  constructor(creds: { key: string; secret: string; passphrase: string }, privateKey?: string) {
    this.privateKey = privateKey;
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

  async getBalance(retries = 3) {
    if (!this.client) throw new Error("Client not initialized");
    
    for (let i = 0; i < retries; i++) {
        try {
            return await this.client.getBalanceAllowance({
                asset_type: AssetType.COLLATERAL,
            });
        } catch (error: any) {
            if (i === retries - 1) throw error;
            console.warn(`[POLY] Balance fetch failed (Attempt ${i+1}/${retries}): ${error.message}. Retrying...`);
            await new Promise(res => setTimeout(res, 2000)); 
        }
    }
    throw new Error("Failed to fetch balance after retries");
  }

  async approveUSDC() {
    if (!this.privateKey) throw new Error("Private Key not found");
    
    const formattedPK = this.privateKey.startsWith("0x") ? (this.privateKey as `0x${string}`) : (`0x${this.privateKey}` as `0x${string}`);
    const account = privateKeyToAccount(formattedPK);
    
    const USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    
    // BOTH main Polymarket spenders
    const SPENDERS = [
        "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", // Exchange
        "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"  // Neg Risk Adapter (Common for Weather)
    ];
    
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http()
    });

    const abi = parseAbi(["function approve(address spender, uint256 amount) public returns (bool)"]);
    const infinite = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

    console.log(`[EXEC] Sending Master Approvals for ${account.address}...`);
    
    const hashes = [];
    for (const spender of SPENDERS) {
        const hash = await walletClient.sendTransaction({
            to: USDCE_ADDRESS,
            data: encodeFunctionData({
                abi,
                functionName: "approve",
                args: [spender as `0x${string}`, infinite]
            })
        });
        hashes.push(hash);
        // Small delay between transactions
        await new Promise(res => setTimeout(res, 1000));
    }
    
    return hashes;
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

  async redeemWinnings(conditionId: string) {
    if (!this.privateKey) throw new Error("Private Key not found");

    const formattedPK = this.privateKey.startsWith("0x")
      ? (this.privateKey as `0x${string}`)
      : (`0x${this.privateKey}` as `0x${string}`);

    const account = privateKeyToAccount(formattedPK);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http()
    });

    const abi = parseAbi([
      "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
    ]);
    const zeroBytes32 = `0x${"0".repeat(64)}` as `0x${string}`;

    console.log(`[SETTLE] Redeeming winnings for condition ${conditionId}...`);
    return walletClient.sendTransaction({
      to: this.conditionalTokensAddress as `0x${string}`,
      data: encodeFunctionData({
        abi,
        functionName: "redeemPositions",
        args: [
          this.usdcAddress as `0x${string}`,
          zeroBytes32,
          conditionId as `0x${string}`,
          [1n, 2n]
        ]
      })
    });
  }
}
