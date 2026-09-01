import {
  Contract,
  Networks,
  TransactionBuilder,
  xdr,
  rpc,
  Asset,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

const AUTOPILOT_PROTOCOL_CONTRACT_ID = process.env.NEXT_PUBLIC_AUTOPILOT_CONTRACT_ID || "CDCNM3U73F3OK34CCTTCKLWDDLJOBG24VTOPXT3IVNVOCNHAVL4WSE4X";
const SOROBAN_RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

export async function createVaultOnContract(userPublicKey: string): Promise<boolean> {
  const server = new rpc.Server(SOROBAN_RPC_URL);
  
  // Since we don't have Horizon getAccount in @stellar/stellar-sdk easily without a separate Horizon.Server object,
  // we'll just use the rpc getAccount method to build tx
  let account;
  try {
    account = await server.getAccount(userPublicKey);
  } catch (e) {
    console.error("Failed to get account details from Soroban RPC:", e);
    return false;
  }

  const contract = new Contract(AUTOPILOT_PROTOCOL_CONTRACT_ID);
  
  const ownerVal = xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeAccount(
    xdr.PublicKey.publicKeyTypeEd25519(
      require("@stellar/stellar-sdk").StrKey.decodeEd25519PublicKey(userPublicKey)
    )
  ));

  const invokeOp = contract.call("create_vault", ownerVal);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(invokeOp)
    .setTimeout(30)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  
  const signedTxXdr = await signTransaction(preparedTx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  
  const signedTx = require("@stellar/stellar-sdk").TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const response = await server.sendTransaction(signedTx as any);
  
  if (response.status === "ERROR") {
    console.error("Soroban error:", response);
    return false;
  }
  
  return true;
}
