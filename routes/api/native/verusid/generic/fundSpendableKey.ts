import {GenericRequest, SpendableKeyDetailsOrdinalVDXFObject} from 'verus-typescript-primitives';
import {VerusdRpcInterface} from 'verusd-rpc-ts-client';

import {
  AddressUtxo,
  getCurrencyDisplay,
  getCurrencyValueSats,
  getNativeBalance,
  getSpendableKeyRpcs,
  IdentityResult,
  isSpendableUtxo,
  satsToCoins,
  SPENDABLE_KEY_CLAIM_FEE_SATS,
  SPENDABLE_KEY_CLAIM_IDENTITY_SWEEP_FEE_SATS,
  SPENDABLE_KEY_CLAIM_NON_NATIVE_FEE_SATS,
  sumUtxoBalances,
} from './discoverSpendableKeyClaims';
import {spendableKeyDetailsOrdinalToMnemonic} from './unlockSpendableKey';

// dev_options.ts uses module.exports, so it can only be required.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {ROOT_SYSTEM_ID, ROOT_SYSTEM_NAME} = require('../../../utils/constants/dev_options');

// Ported from Verus Mobile's src/utils/giftCard/giftCard.js (funding part), keeping its function
// names. The wallet's transactions are built, signed and sent by Desktop's daemon.

const OPERATION_POLL_MS = 500;
const OPERATION_POLL_LIMIT = 240;

interface FundingAmount {
  currency: string;
  amount: string;
}

interface FundingCurrency {
  currencyId: string;
  currency: string;
  satoshis: bigint;
}

interface FundingIdentity {
  identityAddress: string;
  fullyQualifiedName: string;
  identity: Record<string, unknown>;
  nativeSats: bigint;
  currencies: FundingAmount[];
}

interface FundingPlan {
  funds: FundingCurrency[];
  identities: FundingIdentity[];
  topups: FundingCurrency[];
}

interface GiftCardFunding {
  uri: string;
  password?: string;
  address: string;
  funds?: Array<{currency: string; amount: number | string}>;
  identities?: string[];
}

export interface FundingResult {
  type: 'currency' | 'identity';
  txid: string;
  identity: {identityAddress: string; fullyQualifiedName: string} | null;
}

const toFundingAmount = ({currency, satoshis}: FundingCurrency): FundingAmount => ({
  currency,
  amount: satsToCoins(satoshis),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const verifyGiftCardAddresses = async (api: any, funding: GiftCardFunding): Promise<void> => {
  const request = GenericRequest.fromWalletDeeplinkUri(funding.uri);
  const mnemonic = await spendableKeyDetailsOrdinalToMnemonic(
    request.details.find(detail => detail instanceof SpendableKeyDetailsOrdinalVDXFObject),
    funding.password
  );

  // VRSC and VRSCTEST use the same address versions.
  if (api.seedToWif(mnemonic, 'vrsc', true).pub !== funding.address) {
    throw new Error(`Gift card address verification failed for ${ROOT_SYSTEM_NAME}.`);
  }
};

const getFundingCurrency = async (
  rpc: VerusdRpcInterface,
  {currency, amount}: {currency: string; amount: number | string}
): Promise<FundingCurrency> => {
  if (!(Number(amount) > 0) || getCurrencyValueSats(amount) <= 0n) {
    throw new Error(`Invalid amount for ${currency}.`);
  }

  const currencyRes = await rpc.getCurrency(currency);

  if (currencyRes.error) throw new Error(currencyRes.error.message);

  return {
    currencyId: currencyRes.result.currencyid,
    currency,
    satoshis: getCurrencyValueSats(amount),
  };
};

const getFundingIdentity = async (
  rpc: VerusdRpcInterface,
  identityAddress: string,
  cardAddress: string
): Promise<FundingIdentity> => {
  const identityRes = await rpc.getIdentity(identityAddress);

  if (identityRes.error) throw new Error(identityRes.error.message);

  const result = identityRes.result as IdentityResult & {canspendfor?: boolean};
  const {identity} = result;
  const fullyQualifiedName = result.fullyqualifiedname || identityAddress;

  if (identity == null || result.status !== 'active') {
    throw new Error(`${fullyQualifiedName} is not active.`);
  }

  if (result.canspendfor !== true) {
    throw new Error(`This wallet can't move ${fullyQualifiedName}.`);
  }

  if ((identity.primaryaddresses ?? []).includes(cardAddress)) {
    throw new Error(`${fullyQualifiedName} is already on this gift card.`);
  }

  const utxosRes = await rpc.getAddressUtxos({addresses: [identityAddress], friendlynames: true});

  if (utxosRes.error) throw new Error(utxosRes.error.message);

  const utxos = (utxosRes.result ?? []) as AddressUtxo[];
  const currencies: FundingAmount[] = [];

  for (const [currencyId, satoshis] of sumUtxoBalances(ROOT_SYSTEM_ID, utxos).entries()) {
    if (satoshis <= 0n) continue;

    currencies.push({
      currency: await getCurrencyDisplay(rpc, ROOT_SYSTEM_NAME, currencyId),
      amount: satsToCoins(satoshis),
    });
  }

  return {
    identityAddress,
    fullyQualifiedName,
    // Everything else is kept, so content like the contentmultimap survives the update.
    identity: {...identity, primaryaddresses: [cardAddress], minimumsignatures: 1},
    nativeSats: getNativeBalance(
      ROOT_SYSTEM_ID,
      utxos.filter(utxo => isSpendableUtxo(ROOT_SYSTEM_ID, utxo))
    ),
    currencies,
  };
};

const getIdentityOnlyRequiredFeeSats = (identities: FundingIdentity[]): bigint =>
  identities.reduce(
    (total, identity) =>
      identity.nativeSats >= SPENDABLE_KEY_CLAIM_FEE_SATS
        ? total
        : total + SPENDABLE_KEY_CLAIM_FEE_SATS,
    0n
  );

const getIdentityAndFundsRequiredFeeSats = ([
  combinedIdentity,
  ...remainingIdentities
]: FundingIdentity[]): bigint => {
  const combinedFeeSats = SPENDABLE_KEY_CLAIM_IDENTITY_SWEEP_FEE_SATS - combinedIdentity.nativeSats;

  return (
    getIdentityOnlyRequiredFeeSats(remainingIdentities) +
    (combinedFeeSats > 0n ? combinedFeeSats : 0n)
  );
};

// The native coins the card needs so whoever claims it can pay the claim fees.
export const getGiftCardFundingTopups = (
  funds: FundingCurrency[],
  identities: FundingIdentity[]
): FundingCurrency[] => {
  const nativeSelectedSats = funds.reduce(
    (total, fund) => (fund.currencyId === ROOT_SYSTEM_ID ? total + fund.satoshis : total),
    0n
  );
  let requiredFeeSats = 0n;

  if (identities.length > 0 && funds.length > 0) {
    requiredFeeSats = getIdentityAndFundsRequiredFeeSats(identities);
  } else if (identities.length > 0) {
    requiredFeeSats = getIdentityOnlyRequiredFeeSats(identities);
  } else if (funds.some(fund => fund.currencyId !== ROOT_SYSTEM_ID)) {
    requiredFeeSats = SPENDABLE_KEY_CLAIM_NON_NATIVE_FEE_SATS;
  } else if (funds.length > 0) {
    requiredFeeSats = SPENDABLE_KEY_CLAIM_FEE_SATS;
  }

  const topupSats = requiredFeeSats - nativeSelectedSats;

  return topupSats > 0n
    ? [{currencyId: ROOT_SYSTEM_ID, currency: ROOT_SYSTEM_NAME, satoshis: topupSats}]
    : [];
};

const getFundingOutputs = (plan: FundingPlan, address: string) =>
  [...plan.funds, ...plan.topups].map(({currencyId, satoshis}) => ({
    currency: currencyId,
    amount: satsToCoins(satoshis),
    address,
  }));

// Coins held by the IDs being given stay on them, so the card gets what the review shows.
const getFundingSource = (plan: FundingPlan): string => (plan.identities.length > 0 ? 'R*' : '*');

export const preflightGiftCardFunding = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  chainTicker: string,
  funding: GiftCardFunding
): Promise<FundingPlan> => {
  if (chainTicker !== ROOT_SYSTEM_NAME) {
    throw new Error(
      `This spendable key is for ${chainTicker}, but Verus Desktop is using ${ROOT_SYSTEM_NAME}.`
    );
  }

  await verifyGiftCardAddresses(api, funding);

  const {rpc} = getSpendableKeyRpcs(api);
  const funds: FundingCurrency[] = [];
  const identities: FundingIdentity[] = [];

  for (const fund of funding.funds ?? []) funds.push(await getFundingCurrency(rpc, fund));
  for (const identityAddress of funding.identities ?? []) {
    identities.push(await getFundingIdentity(rpc, identityAddress, funding.address));
  }

  if (funds.length === 0 && identities.length === 0) {
    throw new Error('Select funds, a VerusID, or both before continuing.');
  }

  const plan = {funds, identities, topups: getGiftCardFundingTopups(funds, identities)};
  const outputs = getFundingOutputs(plan, funding.address);
  const source = getFundingSource(plan);

  // Dry runs: the outputs as a template, and each identity update signed but not sent.
  if (outputs.length > 0) {
    await api.native.callDaemon(ROOT_SYSTEM_NAME, 'sendcurrency', [source, outputs, 0, 0, true]);
  }

  for (const identity of identities) {
    await api.native.update_identity(ROOT_SYSTEM_NAME, identity.identity, true, false, 0, source);
  }

  return plan;
};

// sendcurrency queues an operation, so its txid is only known once the operation finishes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const waitForOperationTxid = async (api: any, opid: string): Promise<string> => {
  for (let i = 0; i < OPERATION_POLL_LIMIT; i++) {
    const [operation] = await api.native.callDaemon(ROOT_SYSTEM_NAME, 'z_getoperationstatus', [
      [opid],
    ]);

    if (operation?.status === 'success') return operation.result.txid;
    if (operation?.status === 'failed' || operation?.status === 'cancelled') {
      throw new Error(operation.error?.message ?? `Operation ${opid} failed.`);
    }

    await new Promise(resolve => setTimeout(resolve, OPERATION_POLL_MS));
  }

  throw new Error(`Operation ${opid} is still running. Check its status before funding again.`);
};

export const broadcastGiftCardFunding = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  plan: FundingPlan,
  address: string
): Promise<FundingResult[]> => {
  const outputs = getFundingOutputs(plan, address);
  const source = getFundingSource(plan);
  const results: FundingResult[] = [];

  try {
    if (outputs.length > 0) {
      const opid = await api.native.sendcurrency(ROOT_SYSTEM_NAME, source, outputs);

      results.push({type: 'currency', txid: await waitForOperationTxid(api, opid), identity: null});
    }

    for (const {identityAddress, fullyQualifiedName, identity} of plan.identities) {
      results.push({
        type: 'identity',
        txid: await api.native.update_identity(ROOT_SYSTEM_NAME, identity, false, false, 0, source),
        identity: {identityAddress, fullyQualifiedName},
      });
    }
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), {results});
  }

  return results;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (api: any) => {
  api.native.verusid.giftcard.fund_spendable_key_preflight = async (
    chainTicker: string,
    funding: GiftCardFunding
  ) => {
    const plan = await preflightGiftCardFunding(api, chainTicker, funding);

    return {
      identities: plan.identities.map(({identityAddress, fullyQualifiedName, currencies}) => ({
        identityAddress,
        fullyQualifiedName,
        currencies,
      })),
      topups: plan.topups.map(toFundingAmount),
      transactions: [
        ...(plan.funds.length + plan.topups.length > 0 ? [{type: 'currency', identity: null}] : []),
        ...plan.identities.map(({identityAddress, fullyQualifiedName}) => ({
          type: 'identity',
          identity: {identityAddress, fullyQualifiedName},
        })),
      ],
    };
  };

  api.native.verusid.giftcard.fund_spendable_key = async (
    chainTicker: string,
    funding: GiftCardFunding
  ): Promise<{results: FundingResult[]}> => {
    const plan = await preflightGiftCardFunding(api, chainTicker, funding);

    return {results: await broadcastGiftCardFunding(api, plan, funding.address)};
  };

  api.setPost(
    '/native/verusid/giftcard/fund_spendable_key_preflight',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const {chainTicker, ...funding} = req.body;

      try {
        res.send(
          JSON.stringify({
            msg: 'success',
            result: await api.native.verusid.giftcard.fund_spendable_key_preflight(
              chainTicker,
              funding
            ),
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
    },
    true
  );

  api.setPost(
    '/native/verusid/giftcard/fund_spendable_key',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const {chainTicker, ...funding} = req.body;

      try {
        res.send(
          JSON.stringify({
            msg: 'success',
            result: await api.native.verusid.giftcard.fund_spendable_key(chainTicker, funding),
          })
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const results: FundingResult[] = (e as {results?: FundingResult[]})?.results ?? [];

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
