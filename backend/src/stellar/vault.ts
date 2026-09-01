/**
 * stellar/vault.ts
 *
 * Vault management — each user gets two server-controlled Stellar accounts:
 *   - savings vault  → receives auto-save rule executions
 *   - investment vault → receives auto-invest rule executions
 *
 * Vault lifecycle:
 *   1. generateVaultKeypair()  → create random keypair
 *   2. fundAndTrustlineVault() → fund with 2.5 XLM + add USDC trustline (1 tx)
 *   3. Store publicKey + encryptedSecret in DB
 *   4. All future rule executions target the vault's publicKey
 *
 * DB Table: "Vault"
 *   id, userId, type ('savings'|'investment'), publicKey, encryptedSecret,
 *   xlmBalance, usdcBalance, createdAt, updatedAt
 */

import { Keypair } from "@stellar/stellar-sdk";
import { generateVaultKeypair, loadKeypairFromBlob } from "./keypair";
import {
  fetchAccountBalances,
  fetchXLMBalance,
  fetchUSDCBalance,
  accountExists,
  explorerUrl,
  USDC_ASSET,
} from "./horizon";
import { fundAndTrustlineVault, createUSDCTrustline, sendXLM, sendUSDC, mergeAccount } from "./transaction";

export type VaultType = "savings" | "investment";

export interface VaultRecord {
  id: string;
  userId: string;
  type: VaultType;
  publicKey: string;
  encryptedSecret: string;
  xlmBalance: string;
  usdcBalance: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultBalance {
  xlm: number;
  usdc: number;
  isActive: boolean;
  explorerUrl: string;
}

// ── Engine keypair helper ─────────────────────────────────────────────────

function getEngineKeypair(): typeof Keypair.prototype {
  const secret = process.env.AUTOPILOT_SECRET_KEY;
  if (!secret) throw new Error("AUTOPILOT_SECRET_KEY not set");
  return Keypair.fromSecret(secret);
}

// ── Vault creation ────────────────────────────────────────────────────────

/**
 * Create and activate a vault on-chain.
 *
 * 1. Generate a new random keypair
 * 2. Fund it + add USDC trustline in one atomic Stellar transaction
 * 3. Return the vault data ready to be inserted into DB
 *
 * NOTE: costs ~2.5 XLM from the engine account per vault.
 * On testnet, the engine account can be funded for free via friendbot.
 */
export async function createVaultOnChain(
  userId: string,
  type: VaultType
): Promise<{
  publicKey: string;
  encryptedSecret: string;
  fundTxHash: string;
}> {
  const engine = getEngineKeypair();
  const { publicKey, encryptedSecret } = generateVaultKeypair();
  const vaultSigner = loadKeypairFromBlob(encryptedSecret);

  const fundTxHash = await fundAndTrustlineVault(engine, vaultSigner);

  console.log(
    `[Vault] ✅ ${type} vault created for user ${userId.slice(0, 8)}…\n` +
    `       Public key: ${publicKey}\n` +
    `       Funded tx:  ${fundTxHash}`
  );

  return { publicKey, encryptedSecret, fundTxHash };
}

// ── Vault balance ─────────────────────────────────────────────────────────

/** Get live XLM + USDC balance for a vault */
export async function getVaultBalance(publicKey: string): Promise<VaultBalance> {
  const balances = await fetchAccountBalances(publicKey);
  const isActive = balances.length > 0;

  const xlmEntry = balances.find((b) => b.isNative);
  const usdcEntry = balances.find((b) => b.asset.startsWith("USDC:"));

  return {
    xlm: xlmEntry ? parseFloat(xlmEntry.balance) : 0,
    usdc: usdcEntry ? parseFloat(usdcEntry.balance) : 0,
    isActive,
    explorerUrl: explorerUrl("account", publicKey),
  };
}

export async function getVaultContractBalance(vaultId: string): Promise<number | null> {
  try {
    const { Contract, rpc, xdr, Networks, TransactionBuilder } = require("@stellar/stellar-sdk");
    const AUTOPILOT_PROTOCOL_CONTRACT_ID = process.env.AUTOPILOT_CONTRACT_ID || "CDCNM3U73F3OK34CCTTCKLWDDLJOBG24VTOPXT3IVNVOCNHAVL4WSE4X";
    const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
    
    const contract = new Contract(AUTOPILOT_PROTOCOL_CONTRACT_ID);
    const vaultIdVal = xdr.ScVal.scvU64(
      xdr.Uint64.fromString(vaultId)
    );
    
    const invokeOp = contract.call("get_vault", vaultIdVal);
    
    const engineKeypair = getEngineKeypair();
    const engineAccount = await getHorizon().loadAccount(engineKeypair.publicKey());
    
    const tx = new TransactionBuilder(engineAccount, {
      fee: "1000",
      networkPassphrase: Networks.TESTNET
    })
      .addOperation(invokeOp)
      .setTimeout(30)
      .build();

    const server = new rpc.Server(SOROBAN_RPC_URL);
    const simTx = await server.simulateTransaction(tx);
    
    if (rpc.Api.isSimulationSuccess(simTx)) {
      const result = simTx.result.retval;
      // result is a struct Vault { id: u64, owner: Address, balance: i128, yield_earned: i128 }
      // The balance is the 3rd field
      if (result.switch() === xdr.ScValType.scvMap()) {
        const map = result.map();
        // To be safe, let's find the 'balance' key. But in Soroban types mapped to scvMap (like struct), 
        // they are ordered alphabetically or by definition. Wait, `contracttype` structs are arrays (scvVec) or map depending on soroban sdk. Usually maps with symbol keys.
        // Let's just find the value where key is "balance"
        const balanceEntry = map?.find((entry: any) => entry.key().sym().toString() === "balance");
        if (balanceEntry) {
          const val = balanceEntry.val().i128();
          // i128 gives hi/lo.
          const stroops = val.lo().toBigInt() + (val.hi().toBigInt() << 64n);
          return Number(stroops) / 10000000;
        }
      }
    }
    return null;
  } catch (err) {
    console.warn("Failed to get vault contract balance:", err);
    return null;
  }
}


// ── Vault deposits / withdrawals ──────────────────────────────────────────

/**
 * Deposit XLM into a user's vault.
 * Called by the rule processor when a rule fires.
 *
 * @param encryptedSecret  From DB (decrypted internally)
 * @param fromPublicKey    Engine or user source account
 * @param amountXLM        Amount to deposit
 * @param memo             Optional memo
 */
export async function depositXLMToVault(
  vaultPublicKey: string,
  amountXLM: string,
  memo?: string
): Promise<string> {
  const engine = getEngineKeypair();
  return sendXLM(engine, vaultPublicKey, amountXLM, memo ?? "AutoPilot save");
}

/**
 * Deposit USDC into a user's vault.
 */
export async function depositUSDCToVault(
  vaultPublicKey: string,
  amountUSDC: string,
  memo?: string
): Promise<string> {
  const engine = getEngineKeypair();
  return sendUSDC(engine, vaultPublicKey, amountUSDC, memo ?? "AutoPilot save");
}

/**
 * Withdraw XLM from a vault back to the user's wallet.
 *
 * @param encryptedSecret  Encrypted vault secret key from DB
 * @param toPublicKey      User's wallet address (G...)
 * @param amountXLM        Amount to withdraw (leave at least 1.5 XLM for reserve)
 */
export async function withdrawXLMFromVault(
  encryptedSecret: string,
  toPublicKey: string,
  amountXLM: string,
  memo?: string
): Promise<string> {
  const vaultSigner = loadKeypairFromBlob(encryptedSecret);
  return sendXLM(vaultSigner, toPublicKey, amountXLM, memo ?? "AutoPilot withdraw");
}

/**
 * Withdraw USDC from a vault back to the user's wallet.
 */
export async function withdrawUSDCFromVault(
  encryptedSecret: string,
  toPublicKey: string,
  amountUSDC: string,
  memo?: string
): Promise<string> {
  const vaultSigner = loadKeypairFromBlob(encryptedSecret);
  return sendUSDC(vaultSigner, toPublicKey, amountUSDC, memo ?? "AutoPilot withdraw");
}

/**
 * Close a vault — merge all XLM back to the user's wallet.
 * Used when a user disconnects / deletes their account.
 */
export async function closeVault(
  encryptedSecret: string,
  toPublicKey: string
): Promise<string> {
  const vaultSigner = loadKeypairFromBlob(encryptedSecret);
  return mergeAccount(vaultSigner, toPublicKey);
}
