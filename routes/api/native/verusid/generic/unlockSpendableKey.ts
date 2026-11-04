import {createCipheriv, createDecipheriv, pbkdf2, randomBytes} from 'crypto';
import {promisify} from 'util';

import {entropyToMnemonic} from 'bip39';
import {
  GenericRequest,
  SpendableKeyDetailsOrdinalVDXFObject,
} from 'verus-typescript-primitives';

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
export const ENTROPY_LEN = 32;
export const MAX_KDF_ITERS = 1000000;

const pbkdf2Async = promisify(pbkdf2);
const randomBytesAsync = promisify(randomBytes);

// Same format as Verus Mobile's saltedEncrypt: salt | iv | ciphertext | tag.
export const saltedEncrypt = async (password: string, data: Buffer, iters: number): Promise<Buffer> => {
  const salt = await randomBytesAsync(SALT_LEN);
  const iv = await randomBytesAsync(IV_LEN);
  const key = await pbkdf2Async(Buffer.from(password, 'utf8'), salt, iters, KEY_LEN, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  return Buffer.concat([salt, iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
};

const saltedDecrypt = async (password: string, blob: Buffer, iters: number): Promise<Buffer> => {
  const salt = blob.subarray(0, SALT_LEN);
  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(SALT_LEN + IV_LEN, blob.length - TAG_LEN);

  const key = await pbkdf2Async(Buffer.from(password, 'utf8'), salt, iters, KEY_LEN, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};


export const spendableKeyDetailsOrdinalToMnemonic = async (
  detail: unknown,
  password?: string
): Promise<string> => {
    if (
      !(detail instanceof SpendableKeyDetailsOrdinalVDXFObject) ||
      !detail.data.isValid() ||
      !detail.data.isBIP39()
    ) {
      throw new Error('Request does not contain valid spendable key details.');
    }

    const details = detail.data;
    let entropy = details.data;

    if (details.isEncrypted() || details.usesSaltedTaggedAes256Gcm()) {
      if (!password) {
        throw new Error('This spendable key is encrypted. Enter the claim password.');
      }

      if (
        !details.usesSaltedTaggedAes256Gcm() ||
        details.KDFIters.lten(0) ||
        details.KDFIters.gtn(MAX_KDF_ITERS)
      ) {
        throw new Error('Request does not contain valid spendable key details.');
      }

      try {
        entropy = await saltedDecrypt(password, details.data, details.KDFIters.toNumber());
      } catch {
        throw new Error('Unable to decrypt spendable key. Check the password and try again.');
      }
    }

    if (entropy.length !== ENTROPY_LEN) {
      throw new Error('Seed details must contain 32 bytes of BIP39 entropy.');
    }

    return entropyToMnemonic(entropy);
  };
export default (api: any) => {
  api.native.verusid.generic.unlock_spendable_key = async (
    request: GenericRequest,
    detailIndex: number,
    password?: string
  ): Promise<{address: string}> => {
    const mnemonic = await spendableKeyDetailsOrdinalToMnemonic(request.details[detailIndex], password);
    const keys = api.seedToWif(mnemonic, 'vrsc', true);

    return {address: keys.pub};
  };

  api.setPost(
    '/native/verusid/generic/unlock_spendable_key',
    async (req: any, res: any) => {
      const {request, detailIndex, password} = req.body;

      try {
        const genericRequest = new GenericRequest();
        genericRequest.fromBuffer(Buffer.from(request, 'hex'));

        const result = await api.native.verusid.generic.unlock_spendable_key(
          genericRequest,
          detailIndex,
          password
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
    },
    true
  );

  return api;
};
