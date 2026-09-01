import { Contract, Keypair, Networks, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { getHorizon } from "./horizon";
import { getEngineKeypair } from "../lib/engine";

const AUTOPILOT_PROTOCOL_CONTRACT_ID = process.env.AUTOPILOT_CONTRACT_ID || "CDCNM3U73F3OK34CCTTCKLWDDLJOBG24VTOPXT3IVNVOCNHAVL4WSE4X";
const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

function uuidToU64(uuid: string): bigint {
  const hex = uuid.replace(/-/g, '').substring(0, 16);
  return BigInt('0x' + hex);
}

export async function invokeSorobanRuleExecution(
  ruleId: string, 
  paymentAmount: string,
  destination: string
): Promise<string> {
  const engineKeypair = getEngineKeypair();
  const engineAccount = await getHorizon().loadAccount(engineKeypair.publicKey());
  
  const contract = new Contract(AUTOPILOT_PROTOCOL_CONTRACT_ID);
  
  // Convert arguments to ScVal
  const ruleIdVal = xdr.ScVal.scvU64(
    xdr.Uint64.fromString(uuidToU64(ruleId).toString())
  );
  
  // Convert XLM amount (e.g. "10.5") to stroops (105000000) for i128
  const stroops = BigInt(Math.floor(parseFloat(paymentAmount) * 10000000));
  const amountVal = xdr.ScVal.scvI128(new xdr.Int128Parts({
    hi: xdr.Int64.fromString("0"),
    lo: xdr.Uint64.fromString(stroops.toString())
  }));
  
  const invokeOp = contract.call("execute_rule", ruleIdVal, amountVal);

  const paymentOp = require("@stellar/stellar-sdk").Operation.payment({
    destination,
    asset: require("@stellar/stellar-sdk").Asset.native(),
    amount: paymentAmount,
  });

  const tx = new TransactionBuilder(engineAccount, {
    fee: "100000",
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(invokeOp)
    .addOperation(paymentOp)
    .setTimeout(30)
    .build();

  const server = new rpc.Server(SOROBAN_RPC_URL);
  const preparedTx = await server.prepareTransaction(tx);
  preparedTx.sign(engineKeypair);
  
  const response = await server.sendTransaction(preparedTx);
  if (response.status === "ERROR") {
    throw new Error(`Soroban execution failed: ${JSON.stringify(response)}`);
  }
  
  console.log(`[Keeper] Invoked Soroban contract for Rule ${ruleId}. Tx Hash: ${response.hash}`);
  
  // We can poll for completion, but returning the hash immediately is fine for async jobs
  return response.hash;
}
