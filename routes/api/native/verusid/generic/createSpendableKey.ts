import {randomBytes} from 'crypto';
import {promisify} from 'util';

import {entropyToMnemonic} from 'bip39';
import {
  GenericRequest,
  SpendableKeyDetails,
  SpendableKeyDetailsOrdinalVDXFObject,
} from 'verus-typescript-primitives';

import {ENTROPY_LEN, saltedEncrypt} from './unlockSpendableKey';

// dev_options.ts uses module.exports, so it can only be required.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {IS_TESTNET, ROOT_SYSTEM_NAME} = require('../../../utils/constants/dev_options');

// Mobile's SEED_DETAILS_ENCRYPTION_ITERS_LOW, used for the gift cards it creates.
const GIFT_CARD_KDF_ITERS = 100000;

const randomBytesAsync = promisify(randomBytes);

// Mobile's buildSeedDetails for a spendable key, encrypted when a password is given.
const buildSpendableKeyDetails = async (
  entropy: Buffer,
  password?: string
): Promise<SpendableKeyDetails> => {
  const encrypted = password != null && password.length > 0;
  const data = encrypted ? await saltedEncrypt(password, entropy, GIFT_CARD_KDF_ITERS) : entropy;
  const details = SpendableKeyDetails.fromJson({
    flags: 0,
    seedformat: SpendableKeyDetails.SEED_FORMAT_BIP39.toNumber(),
    encryptionformat: (encrypted
      ? SpendableKeyDetails.ENCRYPTION_FORMAT_SALTED_TAGGED_AES_256_GCM
      : SpendableKeyDetails.ENCRYPTION_FORMAT_NONE
    ).toNumber(),
    KDFIters: encrypted ? GIFT_CARD_KDF_ITERS : 0,
    data: data.toString('hex'),
  });

  if (encrypted) {
    details.setEncrypted();
    details.setContainsKDFIters();
  }

  if (!details.isValid()) throw new Error('Failed to create valid seed details.');

  return details;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (api: any) => {
  // Mobile's createGiftCard: a new 24-word key, shared as a generic request link.
  api.native.verusid.giftcard.create_spendable_key = async (
    password?: string
  ): Promise<{uri: string; address: string; encrypted: boolean}> => {
    const entropy = await randomBytesAsync(ENTROPY_LEN);
    const details = await buildSpendableKeyDetails(entropy, password);
    const request = new GenericRequest({
      details: [new SpendableKeyDetailsOrdinalVDXFObject({data: details})],
      flags: IS_TESTNET ? GenericRequest.FLAG_IS_TESTNET : GenericRequest.BASE_FLAGS,
    });
    // VRSC and VRSCTEST use the same address versions.
    const keys = api.seedToWif(entropyToMnemonic(entropy), 'vrsc', true);

    return {
      uri: request.toWalletDeeplinkUri(),
      address: keys.pub,
      encrypted: details.isEncrypted(),
    };
  };

  api.setPost(
    '/native/verusid/giftcard/create_spendable_key',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const {chainTicker, password} = req.body;

      try {
        if (chainTicker !== ROOT_SYSTEM_NAME) {
          throw new Error(
            `This spendable key is for ${chainTicker}, but Verus Desktop is using ${ROOT_SYSTEM_NAME}.`
          );
        }

        res.send(
          JSON.stringify({
            msg: 'success',
            result: await api.native.verusid.giftcard.create_spendable_key(password),
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

  return api;
};
