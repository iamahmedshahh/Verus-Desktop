import {AppEncryptionRequestDetails} from 'verus-typescript-primitives';

import {ZGetEncryptionAddressResult} from '../../zgetencryptionaddress';

// The daemon's encryption index limit (ZIP32_HARDENED_KEY_LIMIT - 1), the same check as Verus Mobile.
const MAX_ENCRYPTION_INDEX = 2147483647;

interface Identity {
  identity: {privateaddress?: string};
}

const checkedIndex = (
  value: AppEncryptionRequestDetails['derivationNumber'],
  name: string
): number => {
  // 31 bits holds every index up to MAX_ENCRYPTION_INDEX.
  if (value == null || value.isNeg() || value.bitLength() > 31) {
    throw new Error(`Invalid ${name}: expected a number from 0 to ${MAX_ENCRYPTION_INDEX}.`);
  }
  return value.toNumber();
};

interface AppEncryptionResult {
  incomingViewingKey: string;
  extendedViewingKey: string;
  address: string;
  extendedSpendingKey?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (api: any) => {
  /**
   * Derives an app's encryption keys like Verus Mobile (appEncryptionRequestHandler.js): from the
   * user's own z spending key (the identity's private address, which stays in the wallet),
   * fromid = the user, toid = the app's scope, encryptionindex = derivationNumber.
   */
  api.native.verusid.generic.execute_app_encryption_request = async (
    coin: string,
    detail: AppEncryptionRequestDetails,
    fromID: string,
    toID: string
  ): Promise<AppEncryptionResult> => {
    // A derivationID asks for a second derivation, which Desktop doesn't do.
    // Answering it would hand over the wrong keys.
    if (detail.hasDerivationID()) {
      throw new Error('App encryption requests with a derivationID are not supported yet.');
    }

    const encryptionIndex = checkedIndex(detail.derivationNumber, 'derivation number');
    const returnSecret = detail.returnESK(detail.flags);

    const identity: Identity = await api.native.get_identity(coin, fromID);
    const zaddress = identity?.identity?.privateaddress;

    if (!zaddress) {
      throw new Error(`Identity ${fromID} has no private address to derive app keys from.`);
    }

    const keys: ZGetEncryptionAddressResult = await api.native.z_get_encryption_address(coin, {
      address: zaddress,
      fromid: fromID,
      toid: toID,
      encryptionindex: encryptionIndex,
      returnsecret: returnSecret,
    });

    if (!keys || !/^[0-9a-f]{64}$/i.test(keys.ivk) || !keys.extendedviewingkey || !keys.address) {
      throw new Error('Incomplete key derivation result.');
    }

    if (returnSecret && !keys.extendedspendingkey) {
      throw new Error('Spending key requested but not returned.');
    }

    return {
      extendedViewingKey: keys.extendedviewingkey,
      incomingViewingKey: keys.ivk,
      address: keys.address,
      extendedSpendingKey: returnSecret ? keys.extendedspendingkey : undefined,
    };
  };

  api.setPost(
    '/native/verusid/generic/execute_app_encryption_request',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const {chainTicker, detailJSON, fromID, toID} = req.body;

      try {
        const detail = AppEncryptionRequestDetails.fromJson(detailJSON);

        const result = await api.native.verusid.generic.execute_app_encryption_request(
          chainTicker,
          detail,
          fromID,
          toID
        );

        res.send(
          JSON.stringify({
            msg: 'success',
            result: result,
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
    // The result holds app keys, so it only travels encrypted, like the gift card routes.
    true
  );

  return api;
};
