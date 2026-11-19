import {DataDescriptor} from 'verus-typescript-primitives';

const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (api: any) => {
  // Encrypts a generic response's details to the request's encryptResponseToAddress, like Verus
  // Mobile does (encryptGenericResponseDetails.js). The daemon does the encryption.
  api.native.verusid.generic.encrypt_generic_response_details = async (
    coin: string,
    detailsHex: string,
    identity: string,
    zaddress: string
  ) => {
    if (typeof detailsHex !== 'string' || !HEX_BYTES.test(detailsHex)) {
      throw new Error('The response details must be a hex string.');
    }

    const signdataResult = await api.native.sign_data(coin, {
      address: identity,
      messagehex: detailsHex,
      encrypttoaddress: zaddress,
    });

    const encryptedDescriptor = signdataResult.mmrdescriptor_encrypted;

    if (
      !encryptedDescriptor ||
      !encryptedDescriptor.datadescriptors ||
      encryptedDescriptor.datadescriptors.length === 0
    ) {
      throw new Error('No encrypted data descriptor returned from signdata.');
    }

    const dataDescriptor = DataDescriptor.fromJson(encryptedDescriptor.datadescriptors[0]);

    if (!dataDescriptor.hasEncryptedData()) {
      throw new Error('signdata did not encrypt the response details.');
    }

    // Only the holder of the request's address may open the details, so no key travels with them.
    if (dataDescriptor.ivk != null || dataDescriptor.ssk != null) {
      throw new Error('signdata returned a decryption key with the response details.');
    }

    return dataDescriptor.toJson();
  };

  api.setPost(
    '/native/verusid/generic/encrypt_generic_response_details',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const {chainTicker, detailsHex, identity, zaddress} = req.body;

      try {
        const result = await api.native.verusid.generic.encrypt_generic_response_details(
          chainTicker,
          detailsHex,
          identity,
          zaddress
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
    // The details can hold saved logins, so they only travel encrypted, like the gift card routes.
    true
  );

  return api;
};
