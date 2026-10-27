import {ECPair, networks, smarttxs, Transaction} from '@bitgo/utxo-lib';
import {GenericRequest} from 'verus-typescript-primitives';
import {I_ADDR_VERSION, R_ADDR_VERSION} from 'verus-typescript-primitives/dist/constants/vdxf';
import {VerusdRpcInterface} from 'verusd-rpc-ts-client';
import {primitives, VerusIdInterface} from 'verusid-ts-client';

import {
  AddressUtxo,
  discoverSpendableKeyClaims,
  getIdentityFeeUtxos,
  getNativeBalance,
  getSpendableKeyRpcs,
  getSweepClaimFee,
  getUtxoNativeSatoshis,
  hasNonNativeBalance,
  IdentityClaim,
  IdentityResult,
  isPureNativeUtxo,
  removeUtxos,
  satsToCoins,
  selectUtxosForAmount,
  shouldCombineIdentityWithSweep,
  SPENDABLE_KEY_CLAIM_FEE_SATS,
  subtractBalanceMap,
  sumUtxoBalances,
  utxoKey,
} from './discoverSpendableKeyClaims';
import {spendableKeyDetailsOrdinalToMnemonic} from './unlockSpendableKey';

// dev_options.ts uses module.exports, so it can only be required.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {ROOT_SYSTEM_ID, ROOT_SYSTEM_NAME} = require('../../../utils/constants/dev_options');

// Ported from Verus Mobile's src/utils/spendableKey/spendableKey.js (claim part) and
// src/utils/api/channels/verusid/requests/updateIdentity.js, keeping their function names.

// verusid-ts-client checks `instanceof Identity`, so objects handed to it are built from the
// primitives it exports rather than Desktop's own copy.
const {
  DEST_ID,
  DEST_PKH,
  Identity,
  OPS,
  OptCCParams,
  TransferDestination,
  decompile,
  fromBase58Check,
} = primitives;
const {getFundedTxBuilder, validateFundedCurrencyTransfer} = smarttxs;

const SPENDABLE_KEY_CLAIM_FEE_COINS = Number(satsToCoins(SPENDABLE_KEY_CLAIM_FEE_SATS));

type ClaimIdentity = InstanceType<typeof Identity>;
type ClaimDestination = InstanceType<typeof TransferDestination>;
type VerusIdUtxos = Parameters<VerusIdInterface['createUpdateIdentityTransaction']>[4];

interface ClaimSystem {
  systemId: string;
  name: string;
  claimWif: string;
  utxos: AddressUtxo[];
  identities: IdentityClaim[];
}

interface SweepOutput {
  currency: string;
  satoshis: string;
  address: ClaimDestination;
}

interface OutputSummary {
  currencyId: string;
  satoshis: string;
  amount: string;
}

interface ClaimTransaction {
  type: 'identity' | 'sweep';
  systemId: string;
  txHex: string;
  inputs: AddressUtxo[];
  keys?: string[][];
  claimWif?: string;
  identity?: {identityAddress: string; fullyQualifiedName?: string};
  outputs: OutputSummary[];
  includesSweep?: boolean;
}

export interface ClaimResult {
  type: 'identity' | 'sweep';
  txid: string;
  includesSweep: boolean;
  identity: {identityAddress: string; fullyQualifiedName?: string} | null;
  outputs: OutputSummary[];
}

interface ClaimIdentityTarget {
  destinationAddress: string;
  privateAddress?: string;
  removePrivateAddress: boolean;
}

const toTransferDestination = (address: string): ClaimDestination => {
  const {hash, version} = fromBase58Check(address);
  let type;

  if (version === R_ADDR_VERSION) {
    type = DEST_PKH;
  } else if (version === I_ADDR_VERSION) {
    type = DEST_ID;
  } else {
    throw new Error('Incompatible address type.');
  }

  return new TransferDestination({destinationBytes: hash, type});
};

const getUsedUtxos = (txHex: string, candidates: AddressUtxo[]): AddressUtxo[] => {
  const tx = Transaction.fromHex(txHex, networks.verus);

  return tx.ins.map((input: {hash: Buffer; index: number}) => {
    const txid = Buffer.from(input.hash).reverse().toString('hex');
    const found = candidates.find(utxo => utxo.txid === txid && utxo.outputIndex === input.index);

    if (!found) {
      throw new Error(`Cannot find transaction input ${txid}:${input.index}`);
    }

    return found;
  });
};

const uniqueUtxos = (utxos: AddressUtxo[]): AddressUtxo[] => {
  const seen = new Set<string>();
  const unique: AddressUtxo[] = [];

  for (const utxo of utxos) {
    const key = utxoKey(utxo);

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(utxo);
    }
  }

  return unique;
};

const getSweepOutputPlan = ({
  system,
  destinationAddress,
  availableUtxos,
  includesIdentityUpdate = false,
}: {
  system: ClaimSystem;
  destinationAddress: string;
  availableUtxos: AddressUtxo[];
  includesIdentityUpdate?: boolean;
}): {feeCoins: number; feeSats: bigint; outputs: SweepOutput[]} => {
  const balanceMap = sumUtxoBalances(system.systemId, availableUtxos);
  const nativeBalance = balanceMap.get(system.systemId) ?? 0n;
  const hasNonNative = Array.from(balanceMap.entries()).some(
    ([currencyId, sats]) => currencyId !== system.systemId && sats > 0n
  );
  const feeSats = getSweepClaimFee(hasNonNative, includesIdentityUpdate);
  const feeCoins = Number(satsToCoins(feeSats));

  if (nativeBalance <= 0n) {
    if (hasNonNative) {
      throw new Error(`Spendable key on ${system.name} has assets but no native funds for fees.`);
    }

    return {feeCoins, feeSats, outputs: []};
  }

  if (nativeBalance < feeSats || (!hasNonNative && nativeBalance <= feeSats)) {
    throw new Error(
      `Spendable key on ${system.name} does not contain enough native funds to pay the sweep fee.`
    );
  }

  const destination = toTransferDestination(destinationAddress);
  const outputs: SweepOutput[] = [];

  for (const [currencyId, sats] of balanceMap.entries()) {
    if (sats <= 0n) continue;

    if (currencyId === system.systemId) {
      const nativeOut = sats - feeSats;

      if (nativeOut > 0n) {
        outputs.push({currency: currencyId, satoshis: nativeOut.toString(), address: destination});
      }
    } else {
      outputs.push({currency: currencyId, satoshis: sats.toString(), address: destination});
    }
  }

  return {feeCoins, feeSats, outputs};
};

const toCurrencyTransferOutputs = (outputs: SweepOutput[]) => {
  const outputIndexes = new Map<string, number>();
  const currencyTransferOutputs: {currencies: Record<string, string>; address: ClaimDestination}[] =
    [];

  for (const {currency, satoshis, address} of outputs) {
    const outputKey = address.getAddressString();
    let outputIndex = outputIndexes.get(outputKey);

    if (outputIndex == null) {
      outputIndex = currencyTransferOutputs.length;
      outputIndexes.set(outputKey, outputIndex);
      currencyTransferOutputs.push({currencies: {}, address});
    }

    const currencyOutput = currencyTransferOutputs[outputIndex];
    const previousSatoshis = currencyOutput.currencies[currency];

    currencyOutput.currencies[currency] =
      previousSatoshis == null
        ? satoshis
        : (BigInt(previousSatoshis) + BigInt(satoshis)).toString();
  }

  return currencyTransferOutputs;
};

const toOutputSummaries = (outputs: SweepOutput[]): OutputSummary[] =>
  outputs.map(output => ({
    currencyId: output.currency,
    satoshis: output.satoshis,
    amount: satsToCoins(BigInt(output.satoshis)),
  }));

const getIdentityBalanceOutputSummaries = (
  system: ClaimSystem,
  identity: IdentityClaim,
  excludedUtxos: AddressUtxo[] = []
): OutputSummary[] => {
  const excludedKeys = new Set(excludedUtxos.map(utxoKey));
  const retainedUtxos = identity.utxos.filter(utxo => !excludedKeys.has(utxoKey(utxo)));

  return Array.from(sumUtxoBalances(system.systemId, retainedUtxos).entries())
    .filter(([, sats]) => sats > 0n)
    .map(([currencyId, sats]) => ({
      currencyId,
      satoshis: sats.toString(),
      amount: satsToCoins(sats),
    }));
};

const getNativeFeeSatsFromDeltas = (
  deltas: Map<string, {toString(): string}> | undefined,
  systemId: string,
  fallbackFeeSats: bigint
): bigint => {
  const nativeDelta = deltas?.get(systemId);

  if (nativeDelta == null) return fallbackFeeSats;

  const sats = BigInt(nativeDelta.toString());

  return sats < 0n ? -sats : sats;
};

const getIdentityUtxosUsed = (identity: IdentityClaim, usedUtxos: AddressUtxo[]): AddressUtxo[] => {
  const identityUtxoKeys = new Set(identity.utxos.map(utxoKey));

  return usedUtxos.filter(utxo => identityUtxoKeys.has(utxoKey(utxo)));
};

const extractIdOutputFromTx = (rawIdTx: string, vout: number | null = null): ClaimIdentity => {
  const identityTransaction = Transaction.fromHex(rawIdTx, networks.verus);

  for (let i = vout != null ? vout : 0; i < identityTransaction.outs.length; i++) {
    if (vout != null && i > vout) break;

    const output = identityTransaction.outs[i];
    const decomp = decompile(Buffer.from(output.script));

    if (decomp.length !== 4) continue;
    if (decomp[1] !== OPS.OP_CHECKCRYPTOCONDITION) continue;
    if (decomp[3] !== OPS.OP_DROP) continue;

    try {
      const outParams = OptCCParams.fromChunk(Buffer.from(decomp[2] as Buffer));
      const identity = new Identity();

      identity.fromBuffer(outParams.getParamObject());

      return identity;
    } catch {
      continue;
    }
  }

  throw new Error('Could not find identity output in tx');
};

// Reads the identity from the transaction that holds it instead of trusting the RPC's JSON.
const getUpdatableIdentity = async (
  rpc: VerusdRpcInterface,
  identityResult: IdentityResult
): Promise<{tx: string; identity: ClaimIdentity}> => {
  const rawIdTxRes = await rpc.getRawTransaction(identityResult.txid as string, 0);

  if (rawIdTxRes.error) throw new Error(rawIdTxRes.error.message);

  const rawIdTx = rawIdTxRes.result as string;
  const identity = extractIdOutputFromTx(rawIdTx, identityResult.vout);

  if (identityResult.identity?.identityaddress !== identity.getIdentityAddress()) {
    throw new Error('Identity from rawtx does not match intended identity');
  }

  return {tx: rawIdTx, identity};
};

const createUpdateIdentityTxWithUtxos = ({
  verusId,
  identity,
  changeAaddr,
  rawIdTx,
  idHeight,
  utxos,
  maxFee,
  isTestnet,
}: {
  verusId: VerusIdInterface;
  identity: ClaimIdentity;
  changeAaddr: string;
  rawIdTx: string;
  idHeight: number;
  utxos: AddressUtxo[];
  maxFee: number;
  isTestnet: boolean;
}) =>
  verusId.createUpdateIdentityTransaction(
    identity,
    changeAaddr,
    rawIdTx,
    idHeight,
    utxos as unknown as VerusIdUtxos,
    undefined,
    maxFee,
    undefined,
    undefined,
    undefined,
    true,
    isTestnet
  );

const createUpdateIdentityWithCurrencyTransferTx = ({
  verusId,
  systemId,
  identity,
  changeAaddr,
  rawIdTx,
  idHeight,
  currencyTransferOutputs,
  utxos,
  maxFee,
  expectedIdentityPrimaryAddress,
  isTestnet,
}: {
  verusId: VerusIdInterface;
  systemId: string;
  identity: ClaimIdentity;
  changeAaddr: string;
  rawIdTx: string;
  idHeight: number;
  currencyTransferOutputs: ReturnType<typeof toCurrencyTransferOutputs>;
  utxos: AddressUtxo[];
  maxFee: number;
  expectedIdentityPrimaryAddress: string;
  isTestnet: boolean;
}) =>
  verusId.createUpdateIdentityWithCurrencyTransferTransaction(
    identity,
    changeAaddr,
    rawIdTx,
    idHeight,
    currencyTransferOutputs,
    utxos as unknown as VerusIdUtxos,
    {
      chainIAddr: systemId,
      maxFee,
      parseVdxfObjects: true,
      isTestnet,
      expectedIdentityPrimaryAddress,
    }
  );

const applyClaimedIdentityAddresses = ({
  identity,
  destinationAddress,
  privateAddress,
  removePrivateAddress,
}: ClaimIdentityTarget & {identity: ClaimIdentity}): void => {
  identity.setPrimaryAddresses([destinationAddress]);

  if (privateAddress) {
    identity.setPrivateAddress(privateAddress);
  } else if (removePrivateAddress) {
    identity.privateAddresses = [];
  }
};

const buildSweepTransaction = async ({
  rpc,
  system,
  destinationAddress,
  availableUtxos,
}: {
  rpc: VerusdRpcInterface;
  system: ClaimSystem;
  destinationAddress: string;
  availableUtxos: AddressUtxo[];
}): Promise<ClaimTransaction | null> => {
  const {feeCoins, feeSats, outputs} = getSweepOutputPlan({
    system,
    destinationAddress,
    availableUtxos,
  });

  if (outputs.length === 0) return null;

  const infoRes = await rpc.getInfo();
  if (infoRes.error) throw new Error(infoRes.error.message);

  const unfundedTxHex = VerusIdInterface.createUnfundedCurrencyTransferTransaction(
    system.systemId,
    toCurrencyTransferOutputs(outputs),
    Number(infoRes.result.longestchain) + 100
  );

  const fundRes = await rpc.fundRawTransaction(
    unfundedTxHex,
    availableUtxos.map(utxo => ({voutnum: utxo.outputIndex, txid: utxo.txid})),
    destinationAddress,
    feeCoins
  );

  if (fundRes.error) throw new Error(fundRes.error.message);

  const validation = validateFundedCurrencyTransfer(
    system.systemId,
    fundRes.result.hex,
    unfundedTxHex,
    destinationAddress,
    networks.verus,
    availableUtxos
  );

  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const actualNativeFee = BigInt(validation.fees?.[system.systemId] ?? 0);

  if (actualNativeFee > feeSats) {
    throw new Error('Fee exceeds maximum spendable key claim fee.');
  }

  return {
    type: 'sweep',
    systemId: system.systemId,
    txHex: fundRes.result.hex,
    inputs: getUsedUtxos(fundRes.result.hex, availableUtxos),
    claimWif: system.claimWif,
    outputs: toOutputSummaries(outputs),
  };
};

const buildCombinedIdentityAndSweepTransaction = async ({
  rpc,
  verusId,
  requestIsTestnet,
  system,
  identity,
  target,
  availableUtxos,
}: {
  rpc: VerusdRpcInterface;
  verusId: VerusIdInterface;
  requestIsTestnet: boolean;
  system: ClaimSystem;
  identity: IdentityClaim;
  target: ClaimIdentityTarget;
  availableUtxos: AddressUtxo[];
}): Promise<ClaimTransaction> => {
  const fundingUtxos = uniqueUtxos(availableUtxos);
  const {feeCoins, outputs} = getSweepOutputPlan({
    system,
    destinationAddress: identity.identityAddress,
    availableUtxos: fundingUtxos,
    includesIdentityUpdate: true,
  });

  const updatableIdentity = await getUpdatableIdentity(rpc, identity.result);

  applyClaimedIdentityAddresses({identity: updatableIdentity.identity, ...target});

  const spentIdentityUtxos = getIdentityUtxosUsed(identity, fundingUtxos);
  const changeAddress =
    spentIdentityUtxos.length > 0 ? identity.identityAddress : target.destinationAddress;
  const updateTx = await createUpdateIdentityWithCurrencyTransferTx({
    verusId,
    systemId: system.systemId,
    identity: updatableIdentity.identity,
    changeAaddr: changeAddress,
    rawIdTx: updatableIdentity.tx,
    idHeight: identity.result.blockheight as number,
    currencyTransferOutputs: toCurrencyTransferOutputs(outputs),
    utxos: fundingUtxos,
    maxFee: feeCoins,
    expectedIdentityPrimaryAddress: target.destinationAddress,
    isTestnet: requestIsTestnet,
  });
  const inputs = updateTx.utxos as unknown as AddressUtxo[];

  return {
    type: 'identity',
    systemId: system.systemId,
    txHex: updateTx.hex,
    inputs,
    keys: inputs.map(() => [system.claimWif]),
    identity: {
      identityAddress: identity.identityAddress,
      fullyQualifiedName: identity.fullyQualifiedName,
    },
    outputs: [
      ...toOutputSummaries(outputs),
      ...getIdentityBalanceOutputSummaries(system, identity, spentIdentityUtxos),
    ],
    includesSweep: true,
  };
};

const buildIdentityTransactionWithIdentityFee = async ({
  rpc,
  verusId,
  requestIsTestnet,
  system,
  identity,
  target,
  feeUtxos,
}: {
  rpc: VerusdRpcInterface;
  verusId: VerusIdInterface;
  requestIsTestnet: boolean;
  system: ClaimSystem;
  identity: IdentityClaim;
  target: ClaimIdentityTarget;
  feeUtxos: AddressUtxo[];
}): Promise<ClaimTransaction> => {
  const updatableIdentity = await getUpdatableIdentity(rpc, identity.result);

  applyClaimedIdentityAddresses({identity: updatableIdentity.identity, ...target});

  const updateTx = await createUpdateIdentityTxWithUtxos({
    verusId,
    identity: updatableIdentity.identity,
    changeAaddr: identity.identityAddress,
    rawIdTx: updatableIdentity.tx,
    idHeight: identity.result.blockheight as number,
    utxos: feeUtxos,
    maxFee: SPENDABLE_KEY_CLAIM_FEE_COINS,
    isTestnet: requestIsTestnet,
  });
  const actualFeeSats = getNativeFeeSatsFromDeltas(
    updateTx.deltas,
    system.systemId,
    SPENDABLE_KEY_CLAIM_FEE_SATS
  );
  const changeBalances = sumUtxoBalances(system.systemId, feeUtxos);

  subtractBalanceMap(changeBalances, system.systemId, actualFeeSats);

  const changeOutputs = Array.from(changeBalances.entries())
    .filter(([, sats]) => sats > 0n)
    .map(([currencyId, sats]) => ({
      currencyId,
      satoshis: sats.toString(),
      amount: satsToCoins(sats),
    }));
  const inputs = updateTx.utxos as unknown as AddressUtxo[];

  return {
    type: 'identity',
    systemId: system.systemId,
    txHex: updateTx.hex,
    inputs,
    keys: inputs.map(() => [system.claimWif]),
    identity: {
      identityAddress: identity.identityAddress,
      fullyQualifiedName: identity.fullyQualifiedName,
    },
    outputs: [...changeOutputs, ...getIdentityBalanceOutputSummaries(system, identity, feeUtxos)],
  };
};

// Desktop only scans its root chain, so this is Mobile's per-system loop body for one system.
export const preflightSpendableKeyClaim = async ({
  rpc,
  verusId,
  requestIsTestnet,
  system,
  target,
}: {
  rpc: VerusdRpcInterface;
  verusId: VerusIdInterface;
  requestIsTestnet: boolean;
  system: ClaimSystem;
  target: ClaimIdentityTarget;
}): Promise<ClaimTransaction[]> => {
  const transactions: ClaimTransaction[] = [];
  const unsupportedIdentity = system.identities.find(identity => identity.unsupportedReason);

  if (unsupportedIdentity) {
    throw new Error(unsupportedIdentity.unsupportedReason as string);
  }

  if (!target.destinationAddress) {
    throw new Error(`No destination address found for ${system.name}.`);
  }

  let availableUtxos = [...system.utxos];

  for (let i = 0; i < system.identities.length; i++) {
    const identity = system.identities[i];
    const feeCandidates = availableUtxos.filter(isPureNativeUtxo(system.systemId));
    const feeUtxos = selectUtxosForAmount(feeCandidates, SPENDABLE_KEY_CLAIM_FEE_SATS, utxo =>
      getUtxoNativeSatoshis(system.systemId, utxo)
    );
    const combineIdentityWithSweep = shouldCombineIdentityWithSweep(
      system.systemId,
      availableUtxos,
      identity,
      i === system.identities.length - 1
    );

    if (combineIdentityWithSweep) {
      const hasNonNative = hasNonNativeBalance(system.systemId, availableUtxos);
      const feeSats = getSweepClaimFee(hasNonNative, true);
      const nativeBalance = getNativeBalance(system.systemId, availableUtxos);
      let combinedUtxos = availableUtxos;

      if (nativeBalance < feeSats || (!hasNonNative && nativeBalance <= feeSats)) {
        const identityFeeUtxos = getIdentityFeeUtxos(
          system.systemId,
          identity,
          feeSats,
          nativeBalance
        );

        if (identityFeeUtxos != null) {
          combinedUtxos = uniqueUtxos([...availableUtxos, ...identityFeeUtxos]);
        }
      }

      transactions.push(
        await buildCombinedIdentityAndSweepTransaction({
          rpc,
          verusId,
          requestIsTestnet,
          system,
          identity,
          target,
          availableUtxos: combinedUtxos,
        })
      );
      availableUtxos = [];
      continue;
    }

    if (feeUtxos == null) {
      const identityFeeUtxos = getIdentityFeeUtxos(
        system.systemId,
        identity,
        SPENDABLE_KEY_CLAIM_FEE_SATS
      );

      if (identityFeeUtxos == null) {
        throw new Error(
          `Spendable key on ${system.name} does not contain enough native fee UTXOs to update ${identity.fullyQualifiedName || identity.identityAddress}.`
        );
      }

      transactions.push(
        await buildIdentityTransactionWithIdentityFee({
          rpc,
          verusId,
          requestIsTestnet,
          system,
          identity,
          target,
          feeUtxos: identityFeeUtxos,
        })
      );

      if (!hasNonNativeBalance(system.systemId, availableUtxos)) {
        availableUtxos = [];
      }

      continue;
    }

    const updatableIdentity = await getUpdatableIdentity(rpc, identity.result);

    applyClaimedIdentityAddresses({identity: updatableIdentity.identity, ...target});

    const updateTx = await createUpdateIdentityTxWithUtxos({
      verusId,
      identity: updatableIdentity.identity,
      changeAaddr: target.destinationAddress,
      rawIdTx: updatableIdentity.tx,
      idHeight: identity.result.blockheight as number,
      utxos: feeUtxos,
      maxFee: SPENDABLE_KEY_CLAIM_FEE_COINS,
      isTestnet: requestIsTestnet,
    });
    const inputs = updateTx.utxos as unknown as AddressUtxo[];
    const fundingInputs = inputs.filter(utxo =>
      availableUtxos.some(candidate => utxoKey(candidate) === utxoKey(utxo))
    );

    availableUtxos = removeUtxos(availableUtxos, fundingInputs);

    transactions.push({
      type: 'identity',
      systemId: system.systemId,
      txHex: updateTx.hex,
      inputs,
      keys: inputs.map(() => [system.claimWif]),
      identity: {
        identityAddress: identity.identityAddress,
        fullyQualifiedName: identity.fullyQualifiedName,
      },
      outputs: getIdentityBalanceOutputSummaries(system, identity),
    });
  }

  const sweepTransaction = await buildSweepTransaction({
    rpc,
    system,
    destinationAddress: target.destinationAddress,
    availableUtxos,
  });

  if (sweepTransaction != null) {
    transactions.push(sweepTransaction);
  }

  if (transactions.length === 0) {
    throw new Error('No claimable transparent funds or VerusIDs were found on this spendable key.');
  }

  return transactions;
};

const signSweepTransaction = (transaction: ClaimTransaction): string => {
  const txb = getFundedTxBuilder(
    transaction.txHex,
    networks.verus,
    transaction.inputs.map(input => Buffer.from(input.script, 'hex'))
  );

  for (let i = 0; i < transaction.inputs.length; i++) {
    const keyPair = ECPair.fromWIF(transaction.claimWif, networks.verus);

    txb.sign(i, keyPair, null, Transaction.SIGHASH_ALL, transaction.inputs[i].satoshis);
  }

  return txb.build().toHex();
};

const deriveRawTransactionId = (rawTx: string): string =>
  Transaction.fromHex(rawTx, networks.verus).getId();

// Mobile's prepareSpendableKeyClaimBroadcast and broadcastPendingTransactions, without the saved
// retry (durableBroadcast): sign everything first, then send in order and stop at the first error.
export const broadcastSpendableKeyClaim = async ({
  rpc,
  verusId,
  transactions,
}: {
  rpc: VerusdRpcInterface;
  verusId: VerusIdInterface;
  transactions: ClaimTransaction[];
}): Promise<ClaimResult[]> => {
  const signedTransactions = transactions.map(transaction => {
    let rawTx: string;

    if (transaction.type === 'identity') {
      rawTx = verusId.signUpdateIdentityTransaction(
        transaction.txHex,
        transaction.inputs as unknown as VerusIdUtxos,
        transaction.keys as string[][]
      );
    } else if (transaction.type === 'sweep') {
      rawTx = signSweepTransaction(transaction);
    } else {
      throw new Error(`Unsupported spendable-key transaction type: ${transaction.type}`);
    }

    return {transaction, rawTx, txid: deriveRawTransactionId(rawTx)};
  });
  const results: ClaimResult[] = [];

  for (const {transaction, rawTx, txid} of signedTransactions) {
    const response = await rpc.sendRawTransaction(rawTx);
    let broadcastError: string | null = null;

    if (response.error != null) {
      broadcastError = response.error.message;
    } else if (typeof response.result !== 'string' || response.result.length === 0) {
      broadcastError = 'Transaction broadcast returned no transaction ID.';
    } else if (response.result.toLowerCase() !== txid.toLowerCase()) {
      broadcastError = 'Transaction broadcast returned an unexpected transaction ID.';
    }

    if (broadcastError != null) {
      throw Object.assign(new Error(broadcastError), {results});
    }

    results.push({
      type: transaction.type,
      txid,
      includesSweep: transaction.includesSweep === true,
      identity: transaction.identity ?? null,
      outputs: transaction.outputs,
    });
  }

  return results;
};

// Mobile always claims to the profile's own addresses, so the chosen ones must be in this wallet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const assertWalletAddress = async (api: any, address: string): Promise<void> => {
  const result = await api.native.validate_address(ROOT_SYSTEM_NAME, address);

  if (!result?.isvalid || !result?.ismine) {
    throw new Error(`${address} is not an address in this wallet.`);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (api: any) => {
  // privateAddress: a z-address sets it on claimed IDs, null removes theirs, undefined keeps it.
  api.native.verusid.generic.claim_spendable_key = async (
    request: GenericRequest,
    detailIndex: number,
    password: string | undefined,
    destinationAddress: string,
    privateAddress: string | null | undefined
  ): Promise<{results: ClaimResult[]}> => {
    if (fromBase58Check(destinationAddress).version !== R_ADDR_VERSION) {
      throw new Error('The destination must be a transparent R-address.');
    }

    await assertWalletAddress(api, destinationAddress);
    if (privateAddress) await assertWalletAddress(api, privateAddress);

    const mnemonic = await spendableKeyDetailsOrdinalToMnemonic(
      request.details[detailIndex],
      password
    );
    // VRSC and VRSCTEST use the same address versions.
    const keys = api.seedToWif(mnemonic, 'vrsc', true);
    //  scan through the daemon
    const {rpc, identityLookupRpc} = getSpendableKeyRpcs(api);
    const verusId = new VerusIdInterface(ROOT_SYSTEM_ID, '', undefined, rpc.rpcRequestOverride);
    const {utxos, identities} = await discoverSpendableKeyClaims(
      rpc,
      ROOT_SYSTEM_ID,
      ROOT_SYSTEM_NAME,
      keys.pub,
      identityLookupRpc
    );
    const transactions = await preflightSpendableKeyClaim({
      rpc,
      verusId,
      requestIsTestnet: request.isTestnet(),
      system: {
        systemId: ROOT_SYSTEM_ID,
        name: ROOT_SYSTEM_NAME,
        claimWif: keys.priv,
        utxos,
        identities,
      },
      target: {
        destinationAddress,
        privateAddress: privateAddress ?? undefined,
        removePrivateAddress: privateAddress === null,
      },
    });

    return {results: await broadcastSpendableKeyClaim({rpc, verusId, transactions})};
  };

  api.setPost(
    '/native/verusid/generic/claim_spendable_key',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const {chainTicker, request, detailIndex, password, destinationAddress, privateAddress} =
        req.body;

      try {
        if (chainTicker !== ROOT_SYSTEM_NAME) {
          throw new Error(
            `This spendable key is for ${chainTicker}, but Verus Desktop is using ${ROOT_SYSTEM_NAME}.`
          );
        }

        // The request is sent as a hex string of the buffer to avoid IPC serialization issues.
        const genericRequest = new GenericRequest();
        genericRequest.fromBuffer(Buffer.from(request, 'hex'));

        const result = await api.native.verusid.generic.claim_spendable_key(
          genericRequest,
          detailIndex,
          password,
          destinationAddress,
          privateAddress
        );

        res.send(
          JSON.stringify({
            msg: 'success',
            result,
          })
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const results: ClaimResult[] = (e as {results?: ClaimResult[]})?.results ?? [];

        // Transactions sent before the error went through, so they are reported with it.
        res.send(
          JSON.stringify(
            results.length > 0
              ? {msg: 'success', result: {results, partialError: message}}
              : {msg: 'error', result: message}
          )
        );
      }
    },
    true
  );

  return api;
};
