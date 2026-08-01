// Creates a funded testnet account to act as a second, independent seller.
// Prints the new account id + private key for .env.
import "dotenv/config";
import {
  Client,
  AccountCreateTransaction,
  PrivateKey,
  Hbar,
  AccountId,
} from "@hiero-ledger/sdk";

const required = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`Missing ${n}`);
  return v;
};

const operatorId = AccountId.fromString(required("HEDERA_CLIENT_ID"));
const operatorKey = PrivateKey.fromStringECDSA(required("HEDERA_CLIENT_KEY"));

const client = Client.forTestnet().setOperator(operatorId, operatorKey);

const newKey = PrivateKey.generateECDSA();
const tx = await new AccountCreateTransaction()
  .setECDSAKeyWithAlias(newKey)
  .setInitialBalance(new Hbar(5))
  .execute(client);

const receipt = await tx.getReceipt(client);
console.log("new account id :", receipt.accountId!.toString());
console.log("new private key:", newKey.toStringRaw());

client.close();
