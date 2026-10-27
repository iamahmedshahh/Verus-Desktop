import {smarttxs} from '@bitgo/utxo-lib';
import {
  ApiPrimitiveJson,
  ApiRequest,
  EVALS,
  RequestParams,
  toIAddress,
} from 'verus-typescript-primitives';
import {VerusdRpcInterface} from 'verusd-rpc-ts-client';

import {SATOSHIS} from '../../../utils/constants/math';
import {VRPC_ENDPOINTS} from '../../../utils/constants/urls';

// dev_options.ts uses module.exports, so it can only be required.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {ROOT_SYSTEM_ID, ROOT_SYSTEM_NAME} = require('../../../utils/constants/dev_options');

// Ported from Verus Mobile's src/utils/spendableKey/spendableKey.js, keeping its function names.

export const SPENDABLE_KEY_CLAIM_FEE_SATS = 10000n;
const SPENDABLE_KEY_CLAIM_NON_NATIVE_FEE_SATS = 20000n;
const SPENDABLE_KEY_CLAIM_IDENTITY_SWEEP_FEE_SATS = 20000n;
const SATS = BigInt(SATOSHIS);

export interface AddressUtxo {
  txid: string;
  outputIndex: number;
  script: string;
  satoshis: number;
  height?: number;
  isspendable?: boolean | number;
  currencyvalues?: Record<string, number | string>;
  fullyqualifiedname?: string;
  friendlyname?: string;
}

interface IdentityDefinition {
  identityaddress?: string;
  primaryaddresses?: string[];
  minimumsignatures?: number;
  name?: string;
  parent?: string;
  fullyqualifiedname?: string;
  friendlyname?: string;
}

export interface IdentityResult extends IdentityDefinition {
  identity?: IdentityDefinition;
  status?: string;
  blockheight?: number;
  txid?: string;
  vout?: number;
  txout?: {txid: string; voutnum: number};
}

export interface IdentityClaim {
  identityAddress: string;
  fullyQualifiedName?: string;
  result: IdentityResult;
  unsupportedReason: string | null;
  utxos: AddressUtxo[];
}

export interface CurrencyClaim {
  currencyId: string;
  name: string;
  satoshis: bigint;
}

type GetUtxoSats = (utxo: AddressUtxo) => bigint;

// Desktop's pinned verusd-rpc-ts-client has no getIdentitiesWithAddress yet, so this is the same
// request as primitives' newer GetIdentitiesWithAddressRequest, sent through its generic request().
class GetIdentitiesWithAddressRequest extends ApiRequest {
  query: {address: string; unspent: boolean};

  constructor(chain: string, query: {address: string; unspent: boolean}) {
    super(chain, 'getidentitieswithaddress');
    this.query = query;
  }

  getParams(): RequestParams {
    return [this.query];
  }

  toJson(): ApiPrimitiveJson {
    return {chain: this.chain, query: this.query};
  }
}

export const utxoKey = (utxo: AddressUtxo): string => `${utxo.txid}:${utxo.outputIndex}`;

const getCurrencyValueSats = (value: number | string): bigint =>
  BigInt(Number(value).toFixed(8).replace('.', ''));

export const satsToCoins = (sats: bigint): string =>
  `${sats / SATS}.${(sats % SATS).toString().padStart(8, '0')}`.replace(/\.?0+$/, '');

// Only i-address lookups are made here: the API must answer for the address that was asked, and
// the name it returns must hash to that address (Mobile's validateLookupBinding).
const validateLookupBinding = (
  systemName: string,
  lookup: string,
  responseAddress?: string,
  fullyQualifiedName?: string
): void => {
  const candidates = fullyQualifiedName
    ? [toIAddress(fullyQualifiedName), toIAddress(fullyQualifiedName, systemName)]
    : [];

  if (responseAddress !== lookup || !candidates.includes(responseAddress)) {
    throw new Error('RPC response does not match the requested identifier.');
  }
};

const unpackUtxoOutput = (systemId: string, utxo: AddressUtxo, allowNonTransferEvals = false) =>
  smarttxs.unpackOutput(
    {value: Number(utxo.satoshis || 0), script: Buffer.from(utxo.script, 'hex')},
    systemId,
    true,
    allowNonTransferEvals
  );

const isTransferUtxo = (systemId: string, utxo: AddressUtxo): boolean => {
  try {
    unpackUtxoOutput(systemId, utxo);
    return true;
  } catch {
    return false;
  }
};

const isSpendableUtxo = (systemId: string, utxo: AddressUtxo): boolean =>
  (utxo.isspendable === true || utxo.isspendable === 1) && isTransferUtxo(systemId, utxo);

export const getUtxoNativeSatoshis = (systemId: string, utxo: AddressUtxo): bigint => {
  const nativeSats = BigInt(utxo.satoshis || 0);

  if (nativeSats > 0n) return nativeSats;

  const nativeCurrencyValue = utxo.currencyvalues?.[systemId];

  return nativeCurrencyValue == null ? 0n : getCurrencyValueSats(nativeCurrencyValue);
};

const hasPositiveNonNativeCurrencyValue = (
  systemId: string,
  currencyValues: Record<string, number | string> = {}
): boolean =>
  Object.keys(currencyValues).some(
    currencyId => currencyId !== systemId && getCurrencyValueSats(currencyValues[currencyId]) > 0n
  );

const isNativeUtxo = (systemId: string) => (utxo: AddressUtxo) =>
  isTransferUtxo(systemId, utxo) && getUtxoNativeSatoshis(systemId, utxo) > 0n;

export const isPureNativeUtxo = (systemId: string) => (utxo: AddressUtxo) =>
  isNativeUtxo(systemId)(utxo) && !hasPositiveNonNativeCurrencyValue(systemId, utxo.currencyvalues);

export const sumUtxoBalances = (systemId: string, utxos: AddressUtxo[]): Map<string, bigint> => {
  const balances = new Map<string, bigint>();

  for (const utxo of utxos) {
    if (!isTransferUtxo(systemId, utxo)) continue;

    const nativeSats = getUtxoNativeSatoshis(systemId, utxo);
    if (nativeSats > 0n) balances.set(systemId, (balances.get(systemId) ?? 0n) + nativeSats);

    const currencyValues = utxo.currencyvalues ?? {};
    for (const currencyId of Object.keys(currencyValues)) {
      if (currencyId === systemId) continue;

      const sats = getCurrencyValueSats(currencyValues[currencyId]);
      balances.set(currencyId, (balances.get(currencyId) ?? 0n) + sats);
    }
  }

  return balances;
};

export const selectUtxosForAmount = (
  utxos: AddressUtxo[],
  amountSats: bigint,
  getUtxoSats: GetUtxoSats = utxo => BigInt(utxo.satoshis || 0)
): AddressUtxo[] | null => {
  if (amountSats <= 0n) return [];

  const selected: AddressUtxo[] = [];
  let total = 0n;

  for (const utxo of utxos) {
    selected.push(utxo);
    total += getUtxoSats(utxo);

    if (total >= amountSats) return selected;
  }

  return null;
};

export const removeUtxos = (utxos: AddressUtxo[], used: AddressUtxo[]): AddressUtxo[] => {
  const usedKeys = new Set(used.map(utxoKey));
  return utxos.filter(utxo => !usedKeys.has(utxoKey(utxo)));
};

const addBalanceMap = (target: Map<string, bigint>, source: Map<string, bigint>): void => {
  for (const [currencyId, sats] of source.entries()) {
    target.set(currencyId, (target.get(currencyId) ?? 0n) + sats);
  }
};

export const subtractBalanceMap = (
  target: Map<string, bigint>,
  currencyId: string,
  sats: bigint
): void => {
  const nextSats = (target.get(currencyId) ?? 0n) - sats;
  target.set(currencyId, nextSats > 0n ? nextSats : 0n);
};

export const getNativeBalance = (systemId: string, utxos: AddressUtxo[]): bigint =>
  sumUtxoBalances(systemId, utxos).get(systemId) ?? 0n;

export const hasNonNativeBalance = (systemId: string, utxos: AddressUtxo[]): boolean =>
  Array.from(sumUtxoBalances(systemId, utxos).entries()).some(
    ([currencyId, sats]) => currencyId !== systemId && sats > 0n
  );

const hasPositiveBalance = (systemId: string, utxos: AddressUtxo[]): boolean =>
  Array.from(sumUtxoBalances(systemId, utxos).values()).some(sats => sats > 0n);

export const getSweepClaimFee = (hasNonNative: boolean, includesIdentityUpdate = false): bigint => {
  if (includesIdentityUpdate) return SPENDABLE_KEY_CLAIM_IDENTITY_SWEEP_FEE_SATS;

  return hasNonNative ? SPENDABLE_KEY_CLAIM_NON_NATIVE_FEE_SATS : SPENDABLE_KEY_CLAIM_FEE_SATS;
};

export const getIdentityFeeUtxos = (
  systemId: string,
  identity: IdentityClaim,
  feeSats: bigint,
  nativeSatsAvailable = 0n
): AddressUtxo[] | null =>
  selectUtxosForAmount(
    identity.utxos.filter(isNativeUtxo(systemId)),
    feeSats - nativeSatsAvailable,
    utxo => getUtxoNativeSatoshis(systemId, utxo)
  );

export const shouldCombineIdentityWithSweep = (
  systemId: string,
  availableUtxos: AddressUtxo[],
  identity: IdentityClaim,
  isLastIdentity: boolean
): boolean => {
  if (!isLastIdentity) return false;

  const hasNonNative = hasNonNativeBalance(systemId, availableUtxos);
  const nativeBalance = getNativeBalance(systemId, availableUtxos);
  const combinedFeeSats = SPENDABLE_KEY_CLAIM_IDENTITY_SWEEP_FEE_SATS;

  if (hasNonNative && nativeBalance >= combinedFeeSats) return true;
  if (!hasNonNative && nativeBalance > combinedFeeSats) return true;
  if (!hasPositiveBalance(systemId, availableUtxos)) return false;

  const identityFeeUtxos = getIdentityFeeUtxos(systemId, identity, combinedFeeSats, nativeBalance);

  if (identityFeeUtxos == null) return false;

  const totalNative = nativeBalance + getNativeBalance(systemId, identityFeeUtxos);

  return hasNonNative || totalNative > combinedFeeSats;
};

// Dry run of the claim's fee choices, so the shown balances are what the claim will deliver.
const getDisplayFeeSats = (
  systemId: string,
  spendableUtxos: AddressUtxo[],
  identities: IdentityClaim[]
): bigint => {
  let availableUtxos = [...spendableUtxos];
  let displayFeeSats = 0n;
  const claimableIdentities = identities.filter(identity => !identity.unsupportedReason);

  for (let i = 0; i < claimableIdentities.length; i++) {
    const identity = claimableIdentities[i];
    const feeUtxos = selectUtxosForAmount(
      availableUtxos.filter(isPureNativeUtxo(systemId)),
      SPENDABLE_KEY_CLAIM_FEE_SATS,
      utxo => getUtxoNativeSatoshis(systemId, utxo)
    );
    const isLastIdentity = i === claimableIdentities.length - 1;

    if (shouldCombineIdentityWithSweep(systemId, availableUtxos, identity, isLastIdentity)) {
      displayFeeSats += getSweepClaimFee(hasNonNativeBalance(systemId, availableUtxos), true);
      availableUtxos = [];
      continue;
    }

    if (feeUtxos == null) {
      if (getIdentityFeeUtxos(systemId, identity, SPENDABLE_KEY_CLAIM_FEE_SATS) != null) {
        displayFeeSats += SPENDABLE_KEY_CLAIM_FEE_SATS;

        if (!hasNonNativeBalance(systemId, availableUtxos)) availableUtxos = [];
      }

      continue;
    }

    displayFeeSats += SPENDABLE_KEY_CLAIM_FEE_SATS;
    availableUtxos = removeUtxos(availableUtxos, feeUtxos);
  }

  if (availableUtxos.length > 0 && getNativeBalance(systemId, availableUtxos) > 0n) {
    displayFeeSats += getSweepClaimFee(hasNonNativeBalance(systemId, availableUtxos));
  }

  return displayFeeSats;
};

const getIdentityFromResult = (result: IdentityResult): IdentityDefinition =>
  result.identity ?? result;

const getIdentityDisplayName = (
  result: IdentityResult,
  identity: IdentityDefinition,
  systemId: string
): string | undefined => {
  if (result.fullyqualifiedname || result.friendlyname) {
    return result.fullyqualifiedname || result.friendlyname;
  }

  if (identity.fullyqualifiedname || identity.friendlyname) {
    return identity.fullyqualifiedname || identity.friendlyname;
  }

  if (identity.name && (identity.parent == null || identity.parent === systemId)) {
    return `${identity.name}@`;
  }

  return undefined;
};

const normalizeIdentityResults = (result?: IdentityResult | IdentityResult[] | null) => {
  if (result == null) return [];

  return (Array.isArray(result) ? result : [result])
    .filter(identityResult => identityResult != null)
    .map(identityResult => ({
      ...identityResult,
      txid: identityResult.txout?.txid || identityResult.txid,
      vout:
        identityResult.txout?.voutnum == null ? identityResult.vout : identityResult.txout.voutnum,
    }));
};

const enrichIdentityResult = async (
  rpc: VerusdRpcInterface,
  systemName: string,
  identityResult: IdentityResult
): Promise<IdentityResult> => {
  const identity = getIdentityFromResult(identityResult);
  const identityAddress = identity?.identityaddress;

  if (!identity || !identityAddress) return identityResult;

  try {
    const identityRes = await rpc.getIdentity(identityAddress);

    if (identityRes.error) throw new Error(identityRes.error.message);

    const directResult = (identityRes.result ?? {}) as IdentityResult;

    validateLookupBinding(
      systemName,
      identityAddress,
      directResult.identity?.identityaddress,
      directResult.fullyqualifiedname
    );

    return {
      ...directResult,
      ...identityResult,
      blockheight: identityResult.blockheight || directResult.blockheight,
      friendlyname: identityResult.friendlyname || directResult.friendlyname,
      fullyqualifiedname: identityResult.fullyqualifiedname || directResult.fullyqualifiedname,
      status: identityResult.status || directResult.status,
      identity: {...getIdentityFromResult(directResult), ...identity},
      txid: identityResult.txid || directResult.txid,
      vout: identityResult.vout == null ? directResult.vout : identityResult.vout,
    };
  } catch (e) {
    console.warn(e instanceof Error ? e.message : e);
    return identityResult;
  }
};

const enrichIdentityResults = (
  rpc: VerusdRpcInterface,
  systemName: string,
  identityResults: IdentityResult[]
): Promise<IdentityResult[]> =>
  Promise.all(identityResults.map(result => enrichIdentityResult(rpc, systemName, result)));

const getClaimableIdentities = (
  identityResults: IdentityResult[],
  claimAddress: string,
  systemId: string
): IdentityClaim[] =>
  identityResults
    .filter(result => (getIdentityFromResult(result).primaryaddresses ?? []).includes(claimAddress))
    .map(result => {
      const identity = getIdentityFromResult(result);
      const primaryAddresses = identity.primaryaddresses ?? [];
      const active = result.status == null || result.status === 'active';
      let unsupportedReason: string | null = null;

      if (!active) {
        unsupportedReason = 'Identity is not active.';
      } else if (Number(identity.minimumsignatures || 0) !== 1) {
        unsupportedReason = 'Identity requires multiple signatures.';
      } else if (primaryAddresses.length === 0) {
        unsupportedReason = 'Identity has no primary addresses.';
      }

      return {
        identityAddress: identity.identityaddress as string,
        fullyQualifiedName: getIdentityDisplayName(result, identity, systemId),
        result,
        unsupportedReason,
        utxos: [],
      };
    });

const getClaimableIdentitiesFromUtxos = async (
  rpc: VerusdRpcInterface,
  systemId: string,
  systemName: string,
  utxos: AddressUtxo[],
  claimAddress: string
): Promise<IdentityClaim[]> => {
  const identityResults: IdentityResult[] = [];

  for (const utxo of utxos) {
    try {
      const output = unpackUtxoOutput(systemId, utxo, true);

      for (const entry of [output.master, ...(output.params || [])]) {
        if (
          entry?.eval === EVALS.EVAL_IDENTITY_PRIMARY &&
          typeof entry.data?.toJson === 'function'
        ) {
          identityResults.push({
            status: 'active',
            txid: utxo.txid,
            vout: utxo.outputIndex,
            blockheight: utxo.height,
            fullyqualifiedname: utxo.fullyqualifiedname || utxo.friendlyname,
            identity: entry.data.toJson(),
          });
        }
      }
    } catch (e) {
      console.warn(e instanceof Error ? e.message : e);
    }
  }

  return getClaimableIdentities(
    await enrichIdentityResults(rpc, systemName, identityResults),
    claimAddress,
    systemId
  );
};

const mergeIdentityClaims = (...identityLists: IdentityClaim[][]): IdentityClaim[] => {
  const byAddress = new Map<string, IdentityClaim>();

  for (const identityList of identityLists) {
    for (const identity of identityList) {
      if (!identity.identityAddress) continue;

      const previous = byAddress.get(identity.identityAddress);

      byAddress.set(identity.identityAddress, {
        ...previous,
        ...identity,
        result: {...previous?.result, ...identity.result},
      });
    }
  }

  return Array.from(byAddress.values());
};

// getidentitieswithaddress needs -idindex=1, which Desktop doesn't start the daemon with, so only
// this lookup falls back to the public API. It only learns the card's address.
const getIdentitiesWithPrimaryAddress = async (
  rpc: VerusdRpcInterface,
  identityLookupRpc: VerusdRpcInterface,
  systemId: string,
  address: string
): Promise<IdentityResult[]> => {
  const request = new GetIdentitiesWithAddressRequest(systemId, {address, unspent: true});
  let res = await rpc.request<IdentityResult[]>(request);

  if (res.error?.message.includes('-idindex')) {
    res = await identityLookupRpc.request<IdentityResult[]>(request);
  }

  if (res.error) throw new Error(res.error.message);

  return normalizeIdentityResults(res.result);
};

const getIdentityTransferUtxos = async (
  rpc: VerusdRpcInterface,
  systemId: string,
  identityAddress: string,
  knownUtxos: AddressUtxo[]
): Promise<AddressUtxo[]> => {
  const res = await rpc.getAddressUtxos({addresses: [identityAddress], friendlynames: true});

  if (res.error) throw new Error(res.error.message);

  const knownUtxoKeys = new Set(knownUtxos.map(utxoKey));

  return ((res.result ?? []) as AddressUtxo[]).filter(
    utxo => !knownUtxoKeys.has(utxoKey(utxo)) && isTransferUtxo(systemId, utxo)
  );
};

const getCurrencyDisplay = async (
  rpc: VerusdRpcInterface,
  systemName: string,
  currencyId: string
): Promise<string> => {
  try {
    const currencyRes = await rpc.getCurrency(currencyId);

    if (currencyRes.error) throw new Error(currencyRes.error.message);

    const {currencyid, fullyqualifiedname} = currencyRes.result;

    validateLookupBinding(systemName, currencyId, currencyid, fullyqualifiedname);

    return fullyqualifiedname || currencyId;
  } catch {
    return currencyId;
  }
};

export const discoverSpendableKeyClaims = async (
  rpc: VerusdRpcInterface,
  systemId: string,
  systemName: string,
  claimAddress: string,
  identityLookupRpc: VerusdRpcInterface = rpc
): Promise<{utxos: AddressUtxo[]; currencies: CurrencyClaim[]; identities: IdentityClaim[]}> => {
  const utxosRes = await rpc.getAddressUtxos({addresses: [claimAddress], friendlynames: true});

  if (utxosRes.error) throw new Error(utxosRes.error.message);

  const observedUtxos = (utxosRes.result ?? []) as AddressUtxo[];
  const spendableUtxos = observedUtxos.filter(utxo => isSpendableUtxo(systemId, utxo));
  const identitiesFromUtxos = await getClaimableIdentitiesFromUtxos(
    rpc,
    systemId,
    systemName,
    observedUtxos,
    claimAddress
  );
  let identitiesFromRpc: IdentityClaim[] = [];

  try {
    identitiesFromRpc = getClaimableIdentities(
      await enrichIdentityResults(
        rpc,
        systemName,
        await getIdentitiesWithPrimaryAddress(rpc, identityLookupRpc, systemId, claimAddress)
      ),
      claimAddress,
      systemId
    );
  } catch (e) {
    console.warn(e instanceof Error ? e.message : e);
  }

  const identities = await Promise.all(
    mergeIdentityClaims(identitiesFromUtxos, identitiesFromRpc).map(async identity => ({
      ...identity,
      utxos: await getIdentityTransferUtxos(
        rpc,
        systemId,
        identity.identityAddress,
        spendableUtxos
      ),
    }))
  );
  const balanceMap = sumUtxoBalances(systemId, spendableUtxos);

  for (const identity of identities) {
    addBalanceMap(balanceMap, sumUtxoBalances(systemId, identity.utxos));
  }

  subtractBalanceMap(balanceMap, systemId, getDisplayFeeSats(systemId, spendableUtxos, identities));

  const currencies: CurrencyClaim[] = [];

  for (const [currencyId, satoshis] of balanceMap.entries()) {
    if (satoshis <= 0n) continue;

    currencies.push({
      currencyId,
      satoshis,
      name: await getCurrencyDisplay(rpc, systemName, currencyId),
    });
  }

  return {utxos: spendableUtxos, currencies, identities};
};
export const getSpendableKeyRpcs = (api: any) => ({
  rpc: api.native.getRpcInterface(ROOT_SYSTEM_NAME, ROOT_SYSTEM_ID) as VerusdRpcInterface,
  identityLookupRpc: new VerusdRpcInterface(ROOT_SYSTEM_ID, VRPC_ENDPOINTS[ROOT_SYSTEM_NAME]),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (api: any) => {
  api.native.verusid.generic.discover_spendable_key_claims = async (
    chainTicker: string,
    address: string
  ) => {
    if (chainTicker !== ROOT_SYSTEM_NAME) {
      throw new Error(
        `This spendable key is for ${chainTicker}, but Verus Desktop is using ${ROOT_SYSTEM_NAME}.`
      );
    }

    const {rpc, identityLookupRpc} = getSpendableKeyRpcs(api);
    const {currencies, identities} = await discoverSpendableKeyClaims(
      rpc,
      ROOT_SYSTEM_ID,
      ROOT_SYSTEM_NAME,
      address,
      identityLookupRpc
    );

    return {
      currencies: currencies.map(({currencyId, name, satoshis}) => ({
        currencyId,
        name,
        amount: satsToCoins(satoshis),
      })),
      identities: identities.map(({identityAddress, fullyQualifiedName, unsupportedReason}) => ({
        identityAddress,
        fullyQualifiedName,
        unsupportedReason,
      })),
    };
  };

  api.setPost(
    '/native/verusid/generic/discover_spendable_key_claims',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const {chainTicker, address} = req.body;

      try {
        const result = await api.native.verusid.generic.discover_spendable_key_claims(
          chainTicker,
          address
        );

        res.send(
          JSON.stringify({
            msg: 'success',
            result,
          })
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res.send(
          JSON.stringify({
            msg: 'error',
            result: message,
          })
        );
      }
    }
  );

  return api;
};
