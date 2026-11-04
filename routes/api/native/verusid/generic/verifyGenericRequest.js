const {GenericRequest} = require('verus-typescript-primitives');

module.exports = api => {
  /**
   * Verifies a generic request
   * @param {GenericRequest} Request
   */
  api.native.verusid.generic.verify_generic_request = async (coin, request) => {
    const verified = await api.native.verify_hash(
      coin,
      request.signature.identityID.toIAddress(),
      request.getRawDataSha256().toString('hex'),
      request.signature.signatureAsVch.toString('base64')
    );
    return verified ? {verified} : {verified, message: 'Failed to verify signature'};
  };

  api.setPost('/native/verusid/generic/verify_generic_request', async (req, res) => {
    const {chainTicker, request, capability} = req.body;
    const loginConsentCaller =
      req.api_header != null &&
      req.api_header.builtin === true &&
      req.api_header.app_id === 'VERUS_LOGIN_CONSENT_UI';
    let verificationClaim = null;

    try {
      // Same rule as verify_request: only a request with provisioning gets a capability,
      // and verifying with it activates that window's provisioning session.
      if (loginConsentCaller && capability != null) {
        if (
          api.loginConsentUi == null ||
          typeof api.loginConsentUi.beginGenericProvisioningRequestVerification !== 'function'
        ) {
          throw new Error('Login Consent provisioning authorization is unavailable');
        }
        verificationClaim = api.loginConsentUi.beginGenericProvisioningRequestVerification(
          capability,
          request
        );
      }

      // The request is sent as a hex string of the buffer to avoid IPC serialization issues.
      const genericRequest = new GenericRequest();
      genericRequest.fromBuffer(Buffer.from(request, 'hex'));
      const verification = await api.native.verusid.generic.verify_generic_request(
        chainTicker,
        genericRequest
      );
      if (verificationClaim != null && verification.verified === true) {
        verificationClaim.confirm();
      }
      res.send(
        JSON.stringify({
          msg: 'success',
          result: verification,
        })
      );
    } catch (e) {
      res.send(
        JSON.stringify({
          msg: 'error',
          result: e.message,
        })
      );
    } finally {
      if (verificationClaim != null) verificationClaim.release();
    }
  });

  return api;
};
