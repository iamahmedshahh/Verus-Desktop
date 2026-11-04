import {createHash, randomBytes, timingSafeEqual} from 'crypto';

import axios from 'axios';
import base64url from 'base64url';
import {BrowserWindow, shell} from 'electron';
import {
  GENERIC_REQUEST_DEEPLINK_VDXF_KEY,
  GENERIC_RESPONSE_DEEPLINK_VDXF_KEY,
  GenericRequest,
  LOGIN_CONSENT_ID_PROVISIONING_WEBHOOK_VDXF_KEY,
  LOGIN_CONSENT_REDIRECT_VDXF_KEY,
  LOGIN_CONSENT_REQUEST_VDXF_KEY,
  LOGIN_CONSENT_RESPONSE_VDXF_KEY,
  LOGIN_CONSENT_WEBHOOK_VDXF_KEY,
  LoginConsentProvisioningRequest,
  LoginConsentRequest,
  LoginConsentResponse,
  ProvisionIdentityDetailsOrdinalVDXFObject,
  ResponseURI,
} from 'verus-typescript-primitives';

import {pushMessage} from '../../../ipc/ipc';
import {
  bindRedirectToRequest,
  CALLBACK_MAX_BYTES,
  createWebhookRequestConfig,
  getWebhookWithDeadline,
  parseBrowserRedirectUrl,
  parsePublicHttpsUrl,
  postWebhookWithDeadline,
  snapshotRequestRedirects,
} from '../../utils/loginConsentSecurity';
import {ReservedPluginTypes} from '../../utils/plugin/builtin';

const PROVISIONING_CAPABILITY_BYTES = 32;
const PROVISIONING_SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const PROVISIONING_MAX_VERIFICATION_ATTEMPTS = 3;
const PROVISIONING_MAX_SIGN_ATTEMPTS = 8;
const PROVISIONING_MAX_SUBMISSIONS = 8;
const PROVISIONING_MAX_STATUS_REQUESTS = 32;
const PROVISIONING_MAX_STATUS_URIS = 4;
const PROVISIONING_STATUS_MIN_INTERVAL_MS = 1000;

interface RedirectInfo {
  type: string;
  uri: string;
}

interface RequestRedirect {
  uri: string;
  vdxfkey: string;
}

interface OriginInfo {
  id: string;
  search_builtin: boolean;
}

interface ResponseURIJson {
  type: string;
  uri: string;
}

interface SingleURIResult {
  type: 'v1';
  responseKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any;
  redirect: RedirectInfo | null;
}

interface MultiURIResult {
  type: 'v2';
  response: string;
  uris: ResponseURIJson[];
}

type DeeplinkResponse = SingleURIResult | MultiURIResult | {error: string};

interface Deeplink {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

type DeeplinkSnapshot =
  | {version: 'v1'; fingerprint: string; redirects: readonly RequestRedirect[]}
  | {version: 'v2'; fingerprint: string; responseUris: readonly ResponseURIJson[]};

// Where a request's provisioning goes, and the challenge ID its provisioning request must carry.
interface ProvisioningTarget {
  challengeId: string;
  webhookUri: string;
}

interface ProvisioningSession {
  capability: Buffer;
  challengeId: string;
  createdAt: number;
  webhookUri: string;
  requestVerified: boolean;
  verificationAttempts: number;
  verificationInFlight: boolean;
  signAttempts: number;
  signingInFlight: boolean;
  signedRequests: Map<string, {serialized: string; value: unknown}>;
  submissions: number;
  submissionInFlight: boolean;
  statusUris: Set<string>;
  statusRequests: number;
  statusInFlight: boolean;
  lastStatusAt: number;
}

interface PendingEntry {
  fingerprint: string;
  inFlight: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window: any;
  provisioning: ProvisioningSession | null;
  claimId?: string;
}

interface LoginConsentUiDependencies {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  httpClient?: any;
  shell?: {openExternal(url: string): Promise<void>};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lookup?: any;
  now?: () => number;
}

const snapshotResponseUris = (request: GenericRequest): readonly ResponseURIJson[] =>
  Object.freeze((request.responseURIs ?? []).map(uri => Object.freeze(uri.toJson())));

// Like bindRedirectToRequest: the consent window may only answer to URIs the request named.
const bindResponseUrisToRequest = (
  selectedUris: unknown,
  requestUris: readonly ResponseURIJson[]
): ResponseURIJson[] => {
  if (!Array.isArray(selectedUris)) {
    throw new Error('Generic response URI selection is invalid');
  }

  return selectedUris.map(selected => {
    if (selected == null || typeof selected.type !== 'string' || typeof selected.uri !== 'string') {
      throw new Error('Generic response URI selection is invalid');
    }

    const match = requestUris.find(({type, uri}) => type === selected.type && uri === selected.uri);
    if (match == null) {
      throw new Error('Generic response URI was not present in the original request');
    }

    return match;
  });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export = (api: any, dependencies: LoginConsentUiDependencies = {}) => {
  const httpClient = dependencies.httpClient || axios;
  const externalShell = dependencies.shell || shell;
  const lookup = dependencies.lookup;
  const now = dependencies.now || Date.now;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requireLoginConsentCaller = (req: any): void => {
    if (
      req == null ||
      req.api_header == null ||
      req.api_header.builtin !== true ||
      req.api_header.app_id !== ReservedPluginTypes.VERUS_LOGIN_CONSENT_UI
    ) {
      throw new Error('Provisioning transport is restricted to Login Consent');
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseProvisioningServiceResponse = (response: any): any => {
    let value = response && response.data;
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > CALLBACK_MAX_BYTES) {
        throw new Error('Provisioning service response is too large');
      }
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error('Provisioning service returned invalid JSON');
      }
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Provisioning service returned an invalid response');
    }
    return value;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.loginConsentUi = {} as any;
  const pendingRequests = new Map<number, PendingEntry>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requestFingerprint = (request: any): string =>
    createHash('sha256').update(new LoginConsentRequest(request).toBuffer()).digest('hex');

  // The deeplink handler and the consent window pass generic requests as hex.
  const parseGenericRequest = (hex: unknown): GenericRequest => {
    if (typeof hex !== 'string') {
      throw new Error('Generic request must be a hex string');
    }
    const request = new GenericRequest();
    request.fromBuffer(Buffer.from(hex, 'hex'));
    return request;
  };

  // Prefixed so a generic request window can never match a v1 response in sign_response.
  const genericRequestFingerprint = (request: GenericRequest): string =>
    `v2:${createHash('sha256').update(request.toBuffer()).digest('hex')}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responseRequestFingerprint = (response: any): string => {
    const parsedResponse = new LoginConsentResponse(response);
    return requestFingerprint(parsedResponse.decision.request);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provisioningRequestFingerprint = (request: any): string =>
    createHash('sha256')
      .update(new LoginConsentProvisioningRequest(request).toBuffer())
      .digest('hex');

  const stableJsonValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableJsonValue);
    if (value != null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return Object.keys(object)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          if (object[key] !== undefined) result[key] = stableJsonValue(object[key]);
          return result;
        }, {});
    }
    return value;
  };

  const exactRequestSnapshot = (request: unknown): {serialized: string; value: unknown} => {
    // First use the value's normal JSON representation (including toJSON on
    // primitive class instances), exactly as the API response transport does.
    const transportValue = JSON.parse(JSON.stringify(request));
    const value = stableJsonValue(transportValue);
    const serialized = JSON.stringify(value);
    return Object.freeze({
      serialized,
      value,
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsignedProvisioningRequestFingerprint = (request: any): string => {
    const parsed = new LoginConsentProvisioningRequest(request);
    parsed.signature = undefined;
    return createHash('sha256').update(parsed.toBuffer()).digest('hex');
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provisioningWebhookForRequest = (request: any): string | null => {
    const parsedRequest = new LoginConsentRequest(request);
    const matches = (parsedRequest.challenge.provisioning_info || []).filter(
      item => item.vdxfkey === LOGIN_CONSENT_ID_PROVISIONING_WEBHOOK_VDXF_KEY.vdxfid
    );

    if (matches.length === 0) return null;
    if (matches.length !== 1 || typeof matches[0].data !== 'string') {
      throw new Error('Login consent request must contain exactly one provisioning webhook');
    }

    // Reject an unusable/unsafe endpoint before issuing a capability. DNS is
    // still resolved and pinned immediately before each outbound request.
    parsePublicHttpsUrl(matches[0].data);
    return matches[0].data;
  };

  // v1: the webhook is in provisioning_info and the challenge is the login challenge.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loginProvisioningTarget = (request: any): ProvisioningTarget | null => {
    const webhookUri = provisioningWebhookForRequest(request);
    if (webhookUri == null) return null;
    return {challengeId: new LoginConsentRequest(request).challenge.challenge_id, webhookUri};
  };

  // v2: the webhook is the uri of the one provision identity detail, and the consent window
  // uses the request ID as the challenge ID (extractGenericProvisioningRequestContext).
  const genericProvisioningTarget = (request: GenericRequest): ProvisioningTarget | null => {
    const details = request.details.filter(
      (detail): detail is ProvisionIdentityDetailsOrdinalVDXFObject =>
        detail instanceof ProvisionIdentityDetailsOrdinalVDXFObject
    );
    if (details.length === 0) return null;
    if (details.length !== 1) {
      throw new Error('Generic request must contain exactly one provision identity detail');
    }

    const {uri} = details[0].data;
    if (uri == null) return null;
    if (!request.hasRequestID() || request.requestID == null) {
      throw new Error('Generic provisioning request is missing a request ID');
    }

    const webhookUri = uri.getUriString();
    // Same rule as v1: reject an unusable/unsafe endpoint before issuing a capability.
    parsePublicHttpsUrl(webhookUri);
    return {challengeId: request.requestID.toAddress(), webhookUri};
  };

  const decodeProvisioningCapability = (capability: unknown): Buffer | null => {
    if (
      typeof capability !== 'string' ||
      capability.length !== PROVISIONING_CAPABILITY_BYTES * 2 ||
      !/^[0-9a-f]+$/i.test(capability)
    ) {
      return null;
    }
    return Buffer.from(capability, 'hex');
  };

  const pendingEntryIsLive = (entry: PendingEntry | undefined): boolean => {
    const window = entry && entry.window;
    return (
      window != null &&
      (typeof window.isDestroyed !== 'function' || !window.isDestroyed()) &&
      (window.webContents == null ||
        typeof window.webContents.isDestroyed !== 'function' ||
        !window.webContents.isDestroyed())
    );
  };

  const pendingEntryIsLiveAndVisible = (entry: PendingEntry | undefined): boolean => {
    const window = entry && entry.window;
    return (
      pendingEntryIsLive(entry) && (typeof window.isVisible !== 'function' || window.isVisible())
    );
  };

  const pendingEntryIsInteractive = (entry: PendingEntry | undefined): boolean => {
    const window = entry && entry.window;
    return (
      pendingEntryIsLiveAndVisible(entry) &&
      (typeof window.isFocused !== 'function' || window.isFocused())
    );
  };

  const findProvisioningEntry = (
    capability: unknown,
    {requireFocus = true, requireVisibility = true} = {}
  ): {windowId: number; entry: PendingEntry & {provisioning: ProvisioningSession}} => {
    const received = decodeProvisioningCapability(capability);
    let match: {
      windowId: number;
      entry: PendingEntry & {provisioning: ProvisioningSession};
    } | null = null;

    // Do not use a capability string as a Map key. Compare all live sessions
    // in constant time so a shared builtin API secret cannot become an oracle
    // for partially-correct capability values.
    for (const [windowId, entry] of pendingRequests.entries()) {
      const expected = entry.provisioning && entry.provisioning.capability;
      if (
        received != null &&
        Buffer.isBuffer(expected) &&
        expected.length === received.length &&
        timingSafeEqual(expected, received)
      ) {
        match = {windowId, entry: entry as PendingEntry & {provisioning: ProvisioningSession}};
      }
    }

    if (match == null) {
      throw new Error('Provisioning capability is invalid or expired');
    }

    const {windowId, entry} = match;
    if (now() - entry.provisioning.createdAt > PROVISIONING_SESSION_MAX_AGE_MS) {
      pendingRequests.delete(windowId);
      throw new Error('Provisioning capability is invalid or expired');
    }
    if (!pendingEntryIsLive(entry)) {
      throw new Error('The corresponding Login Consent window is no longer active');
    }
    if (requireVisibility && !pendingEntryIsLiveAndVisible(entry)) {
      throw new Error('The corresponding Login Consent window must be live and visible');
    }
    if (requireFocus && !pendingEntryIsInteractive(entry)) {
      throw new Error('The corresponding Login Consent window must be visible and focused');
    }

    return match;
  };

  const assertSameProvisioningChallenge = (
    entry: PendingEntry & {provisioning: ProvisioningSession},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: any
  ): LoginConsentProvisioningRequest => {
    const parsed = new LoginConsentProvisioningRequest(request);
    if (
      parsed.challenge == null ||
      parsed.challenge.challenge_id !== entry.provisioning.challengeId
    ) {
      throw new Error('Provisioning request does not belong to this login-consent session');
    }
    return parsed;
  };

  const addLearnedStatusUri = (
    entry: PendingEntry & {provisioning: ProvisioningSession},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any
  ): void => {
    const infoUri =
      response &&
      response.decision &&
      response.decision.result &&
      response.decision.result.info_uri;
    if (infoUri == null || infoUri === '') return;
    if (typeof infoUri !== 'string') {
      throw new Error('Provisioning service returned an invalid status URI');
    }

    // Validate synchronously now and resolve/pin DNS only if it is later used.
    parsePublicHttpsUrl(infoUri);
    const statusUris = entry.provisioning.statusUris;
    if (!statusUris.has(infoUri) && statusUris.size >= PROVISIONING_MAX_STATUS_URIS) {
      throw new Error('Provisioning service returned too many status URIs');
    }
    statusUris.add(infoUri);
  };

  // Verifying the exact request a window was opened for, with that window's capability,
  // is what lets its provisioning session sign. fingerprintOf hashes the request for its version.
  const beginRequestVerification = (capability: unknown, fingerprintOf: () => string) => {
    const {windowId, entry} = findProvisioningEntry(capability);
    const session = entry.provisioning;
    if (session.verificationInFlight) {
      throw new Error('Login consent request verification is already in progress');
    }
    if (session.verificationAttempts >= PROVISIONING_MAX_VERIFICATION_ATTEMPTS) {
      throw new Error('Login consent verification limit reached for this consent session');
    }
    if (fingerprintOf() !== entry.fingerprint) {
      throw new Error('Login consent request does not belong to this provisioning session');
    }

    session.verificationAttempts += 1;
    session.verificationInFlight = true;
    let finished = false;
    return Object.freeze({
      confirm() {
        if (finished) throw new Error('Login consent verification claim is no longer active');
        if (pendingRequests.get(windowId) !== entry || !pendingEntryIsLive(entry)) {
          throw new Error('The corresponding Login Consent window is no longer active');
        }
        session.requestVerified = true;
        session.verificationInFlight = false;
        finished = true;
      },
      release() {
        if (finished) return;
        session.verificationInFlight = false;
        finished = true;
      },
    });
  };

  // verify_request (v1): the login request as JSON.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.loginConsentUi.beginProvisioningRequestVerification = (capability: unknown, request: any) =>
    beginRequestVerification(capability, () => requestFingerprint(request));

  // verify_generic_request (v2): the generic request as hex.
  api.loginConsentUi.beginGenericProvisioningRequestVerification = (
    capability: unknown,
    request: unknown
  ) =>
    beginRequestVerification(capability, () =>
      genericRequestFingerprint(parseGenericRequest(request))
    );

  api.loginConsentUi.beginProvisioningSigning = (
    capability: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: any,
    signingAddress: unknown
  ) => {
    const {windowId, entry} = findProvisioningEntry(capability);
    const session = entry.provisioning;
    if (session.requestVerified !== true) {
      throw new Error('The original login consent request has not been verified');
    }
    if (session.signingInFlight) {
      throw new Error('A provisioning signing request is already in progress');
    }
    if (session.signAttempts >= PROVISIONING_MAX_SIGN_ATTEMPTS) {
      throw new Error('Provisioning signing limit reached for this consent session');
    }

    const parsed = assertSameProvisioningChallenge(entry, request);
    if (parsed.signature != null) {
      throw new Error('Provisioning request must be unsigned before wallet signing');
    }
    if (typeof signingAddress !== 'string' || parsed.signing_address !== signingAddress) {
      throw new Error('Provisioning signing address does not match the request');
    }

    const unsignedFingerprint = unsignedProvisioningRequestFingerprint(parsed);
    session.signAttempts += 1;
    session.signingInFlight = true;
    let finished = false;
    return Object.freeze({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      register(signedRequest: any) {
        if (finished) throw new Error('Provisioning signing claim is no longer active');
        const current = pendingRequests.get(windowId);
        if (current !== entry || !pendingEntryIsInteractive(entry)) {
          throw new Error('The corresponding Login Consent window is no longer active');
        }
        const signed = assertSameProvisioningChallenge(entry, signedRequest);
        if (signed.signature == null) {
          throw new Error('Wallet did not return a signed provisioning request');
        }
        if (unsignedProvisioningRequestFingerprint(signed) !== unsignedFingerprint) {
          throw new Error('Wallet returned a different provisioning request after signing');
        }
        session.signedRequests.set(
          provisioningRequestFingerprint(signed),
          exactRequestSnapshot(signedRequest)
        );
        session.signingInFlight = false;
        finished = true;
      },
      release() {
        if (finished) return;
        session.signingInFlight = false;
        finished = true;
      },
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.loginConsentUi.beginProvisioningSubmission = (capability: unknown, request: any) => {
    const {windowId, entry} = findProvisioningEntry(capability);
    const session = entry.provisioning;
    if (session.submissionInFlight) {
      throw new Error('A provisioning submission is already in progress');
    }
    if (session.submissions >= PROVISIONING_MAX_SUBMISSIONS) {
      throw new Error('Provisioning submission limit reached for this consent session');
    }

    const signed = assertSameProvisioningChallenge(entry, request);
    if (signed.signature == null) {
      throw new Error('Provisioning request must be signed');
    }
    const fingerprint = provisioningRequestFingerprint(signed);
    const registeredRequest = session.signedRequests.get(fingerprint);
    const submittedRequest = exactRequestSnapshot(request);
    if (registeredRequest == null || registeredRequest.serialized !== submittedRequest.serialized) {
      throw new Error(
        'Provisioning request was not signed for this consent session or was already submitted'
      );
    }
    session.signedRequests.delete(fingerprint);

    session.submissions += 1;
    session.submissionInFlight = true;
    let finished = false;
    return Object.freeze({
      uri: session.webhookUri,
      request: registeredRequest.value,
      recordResponse(response: unknown) {
        if (finished) throw new Error('Provisioning submission claim is no longer active');
        if (pendingRequests.get(windowId) !== entry || !pendingEntryIsLive(entry)) {
          throw new Error('The corresponding Login Consent window is no longer active');
        }
        addLearnedStatusUri(entry, response);
      },
      release() {
        if (finished) return;
        session.submissionInFlight = false;
        finished = true;
      },
    });
  };

  api.loginConsentUi.beginProvisioningStatusRequest = (capability: unknown, uri: unknown) => {
    const {windowId, entry} = findProvisioningEntry(capability, {
      requireFocus: false,
      requireVisibility: false,
    });
    const session = entry.provisioning;
    const requestedAt = now();
    if (session.statusInFlight) {
      throw new Error('A provisioning status request is already in progress');
    }
    if (session.statusRequests >= PROVISIONING_MAX_STATUS_REQUESTS) {
      throw new Error('Provisioning status request limit reached for this consent session');
    }
    if (typeof uri !== 'string' || !session.statusUris.has(uri)) {
      throw new Error('Provisioning status URI was not issued for this consent session');
    }
    if (requestedAt - session.lastStatusAt < PROVISIONING_STATUS_MIN_INTERVAL_MS) {
      throw new Error('Provisioning status requests are being made too quickly');
    }

    session.statusRequests += 1;
    session.lastStatusAt = requestedAt;
    session.statusInFlight = true;
    let finished = false;
    return Object.freeze({
      uri,
      recordResponse(response: unknown) {
        if (finished) throw new Error('Provisioning status claim is no longer active');
        if (pendingRequests.get(windowId) !== entry || !pendingEntryIsLive(entry)) {
          throw new Error('The corresponding Login Consent window is no longer active');
        }
        addLearnedStatusUri(entry, response);
      },
      release() {
        if (finished) return;
        session.statusInFlight = false;
        finished = true;
      },
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matchingPendingEntries = (response: any): [number, PendingEntry][] => {
    const fingerprint = responseRequestFingerprint(response);
    return [...pendingRequests.entries()].filter(
      ([, entry]) =>
        entry.fingerprint === fingerprint &&
        entry.inFlight !== true &&
        pendingEntryIsInteractive(entry)
    );
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.loginConsentUi.hasPendingResponse = (response: any): boolean => {
    try {
      return matchingPendingEntries(response).length === 1;
    } catch {
      return false;
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.loginConsentUi.beginPendingResponse = (response: any) => {
    const matches = matchingPendingEntries(response);
    if (matches.length !== 1) {
      throw new Error('No matching focused login-consent request is pending');
    }
    const [windowId, entry] = matches[0];
    entry.inFlight = true;
    const claimId = randomBytes(16).toString('hex');
    entry.claimId = claimId;
    let finished = false;
    return Object.freeze({
      consume() {
        if (finished) return;
        finished = true;
        const current = pendingRequests.get(windowId);
        if (current === entry && current.claimId === claimId) pendingRequests.delete(windowId);
      },
      release() {
        if (finished) return;
        finished = true;
        const current = pendingRequests.get(windowId);
        if (current === entry && current.claimId === claimId) {
          current.inFlight = false;
          delete current.claimId;
        }
      },
    });
  };

  // Add a slight delay to allow the user to see the desktop GUI briefly.
  const minimizeAfterPost = (): void => {
    setTimeout(() => {
      if (typeof api.minimizeApp === 'function') api.minimizeApp();
    }, 250);
  };

  // Handles the multiple responses in V2 requests.
  api.loginConsentUi.respond = async (response: string, uris: ResponseURIJson[]): Promise<void> => {
    if (!uris || uris.length === 0) return;

    // Convert JSON objects to ResponseURI instances and find the first POST URI, fallback to REDIRECT.
    const responseUris = uris.map(uri => ResponseURI.fromJson(uri));
    const selectedUri =
      responseUris.find(uri => uri.type.eq(ResponseURI.TYPE_POST)) ??
      responseUris.find(uri => uri.type.eq(ResponseURI.TYPE_REDIRECT));

    if (!selectedUri) return;

    // Deserialize the response from hex string to Buffer
    const responseBuffer = Buffer.from(response, 'hex');

    // Handle POST URI.
    if (selectedUri.type.eq(ResponseURI.TYPE_POST)) {
      const {url, config} = await createWebhookRequestConfig(selectedUri.getUriString(), {lookup});
      minimizeAfterPost();
      await postWebhookWithDeadline(httpClient, url, responseBuffer, {
        ...config,
        headers: {'Content-Type': 'application/octet-stream'},
      });
      return;
    }

    // Handle REDIRECT URI.
    const url = parseBrowserRedirectUrl(selectedUri.getUriString());
    url.searchParams.set(GENERIC_RESPONSE_DEEPLINK_VDXF_KEY.vdxfid, base64url(responseBuffer));
    await externalShell.openExternal(url.toString());
  };

  // Handles the old redirect URIs in V1 requests.
  api.loginConsentUi.handle_redirect = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any,
    redirectinfo: RequestRedirect,
    responseKey: string = LOGIN_CONSENT_RESPONSE_VDXF_KEY.vdxfid
  ): Promise<null> => {
    const {vdxfkey, uri} = redirectinfo;

    const handlers = new Map<string, () => Promise<null>>([
      [
        LOGIN_CONSENT_WEBHOOK_VDXF_KEY.vdxfid,
        async () => {
          const {url, config} = await createWebhookRequestConfig(uri, {lookup});
          minimizeAfterPost();
          await postWebhookWithDeadline(httpClient, url, response, config);
          return null;
        },
      ],
      [
        LOGIN_CONSENT_REDIRECT_VDXF_KEY.vdxfid,
        async () => {
          if (responseKey !== LOGIN_CONSENT_RESPONSE_VDXF_KEY.vdxfid) {
            throw new Error(`Unsupported response key for redirecting: ${responseKey}`);
          }

          const url = parseBrowserRedirectUrl(uri);
          const res = new LoginConsentResponse(response);
          url.searchParams.set(responseKey, base64url(res.toBuffer()));

          await externalShell.openExternal(url.toString());
          return null;
        },
      ],
    ]);

    const handler = handlers.get(vdxfkey);
    if (handler == null) {
      throw new Error('Unsupported login consent redirect type');
    }

    return handler();
  };

  // Reads the request the consent window will answer, so its answer can be bound to it.
  const snapshotDeeplinkRequest = (deeplink: Deeplink): DeeplinkSnapshot => {
    if (deeplink == null || typeof deeplink !== 'object') {
      throw new Error('Login consent deeplink is invalid');
    }

    if (deeplink.id === LOGIN_CONSENT_REQUEST_VDXF_KEY.vdxfid) {
      return Object.freeze({
        version: 'v1',
        fingerprint: requestFingerprint(deeplink.data),
        redirects: snapshotRequestRedirects(deeplink.data),
      });
    }

    if (deeplink.id === GENERIC_REQUEST_DEEPLINK_VDXF_KEY.vdxfid) {
      const request = parseGenericRequest(deeplink.data);

      return Object.freeze({
        version: 'v2',
        fingerprint: genericRequestFingerprint(request),
        responseUris: snapshotResponseUris(request),
      });
    }

    throw new Error('Unsupported login consent deeplink type');
  };

  const createProvisioningSession = (deeplink: Deeplink): ProvisioningSession | null => {
    try {
      const target =
        deeplink.id === GENERIC_REQUEST_DEEPLINK_VDXF_KEY.vdxfid
          ? genericProvisioningTarget(parseGenericRequest(deeplink.data))
          : loginProvisioningTarget(deeplink.data);
      if (target == null) return null;

      return {
        capability: randomBytes(PROVISIONING_CAPABILITY_BYTES),
        challengeId: target.challengeId,
        createdAt: now(),
        webhookUri: target.webhookUri,
        requestVerified: false,
        verificationAttempts: 0,
        verificationInFlight: false,
        signAttempts: 0,
        signingInFlight: false,
        signedRequests: new Map(),
        submissions: 0,
        submissionInFlight: false,
        statusUris: new Set(),
        statusRequests: 0,
        statusInFlight: false,
        lastStatusAt: 0,
      };
    } catch (error) {
      if (typeof api.log === 'function') {
        api.log(error, 'loginConsentUi.provisioningCapability');
      }
      return null;
    }
  };

  api.setPost(
    '/native/verusid/provision/submit_id_provisioning_request',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let submissionClaim: any = null;
      try {
        requireLoginConsentCaller(req);
        const {capability, request} = req.body || {};
        if (request == null || typeof request !== 'object' || Array.isArray(request)) {
          throw new Error('Provisioning request must be an object');
        }
        const serializedRequest = JSON.stringify(request);
        if (Buffer.byteLength(serializedRequest, 'utf8') > CALLBACK_MAX_BYTES) {
          throw new Error('Provisioning request is too large');
        }
        submissionClaim = api.loginConsentUi.beginProvisioningSubmission(capability, request);
        const {url, config} = await createWebhookRequestConfig(submissionClaim.uri, {lookup});
        const response = await postWebhookWithDeadline(
          httpClient,
          url,
          submissionClaim.request,
          config
        );
        const parsedResponse = parseProvisioningServiceResponse(response);
        submissionClaim.recordResponse(parsedResponse);
        res.send(
          JSON.stringify({
            msg: 'success',
            result: parsedResponse,
          })
        );
      } catch (error) {
        res.send(JSON.stringify({msg: 'error', result: (error as Error).message}));
      } finally {
        if (submissionClaim != null) submissionClaim.release();
      }
    },
    true
  );

  api.setPost(
    '/native/verusid/provision/get_id_provisioning_status',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let statusClaim: any = null;
      try {
        requireLoginConsentCaller(req);
        const {capability, uri} = req.body || {};
        statusClaim = api.loginConsentUi.beginProvisioningStatusRequest(capability, uri);
        const {url, config} = await createWebhookRequestConfig(statusClaim.uri, {lookup});
        const response = await getWebhookWithDeadline(httpClient, url, config);
        const parsedResponse = parseProvisioningServiceResponse(response);
        statusClaim.recordResponse(parsedResponse);
        res.send(
          JSON.stringify({
            msg: 'success',
            result: parsedResponse,
          })
        );
      } catch (error) {
        res.send(JSON.stringify({msg: 'error', result: (error as Error).message}));
      } finally {
        if (statusClaim != null) statusClaim.release();
      }
    },
    true
  );

  api.loginConsentUi.deeplink = async (
    deeplink: Deeplink,
    originInfo: OriginInfo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> => {
    return new Promise((resolve, reject) => {
      try {
        // Validate and fingerprint before opening a window. Deferring this to
        // did-finish-load would turn malformed input into an uncaught timer
        // exception and leave the caller waiting forever.
        const snapshot = snapshotDeeplinkRequest(deeplink);
        let pendingWindowId: number | null = null;

        const pluginStart = api.startPlugin(
          ReservedPluginTypes.VERUS_LOGIN_CONSENT_UI,
          true,
          async (data: DeeplinkResponse) => {
            try {
              // Closing the window completes the request without any data.
              if (data == null) {
                reject(new Error('The request window was closed.'));
                return;
              }

              if ('error' in data) {
                reject(new Error(data.error));
                return;
              }

              // Handle v2 multi-URI result
              if (data.type === 'v2') {
                if (snapshot.version !== 'v2') {
                  throw new Error('Login consent result does not match the original request');
                }
                await api.loginConsentUi.respond(
                  data.response,
                  bindResponseUrisToRequest(data.uris, snapshot.responseUris)
                );
              } else if (data.type === 'v1') {
                if (snapshot.version !== 'v1') {
                  throw new Error('Login consent result does not match the original request');
                }
                // Handle v1 single-URI result
                if (data.redirect) {
                  const boundRedirect = bindRedirectToRequest(
                    {uri: data.redirect.uri, vdxfkey: data.redirect.type},
                    snapshot.redirects
                  );
                  await api.loginConsentUi.handle_redirect(
                    data.response,
                    boundRedirect,
                    data.responseKey
                  );
                }
              }

              resolve(data.response);
            } catch (e) {
              reject(e);
            } finally {
              if (pendingWindowId != null) pendingRequests.delete(pendingWindowId);
            }
          },
          (pluginWindow: BrowserWindow) => {
            pendingWindowId = pluginWindow.id;
            const provisioning = createProvisioningSession(deeplink);

            // Only v1 login requests are signed through sign_response, which
            // requires a matching focused window. A v2 window is only tracked for
            // its provisioning session; its v2: fingerprint never matches a v1 response.
            if (snapshot.version === 'v1' || provisioning != null) {
              pendingRequests.set(pluginWindow.id, {
                fingerprint: snapshot.fingerprint,
                inFlight: false,
                window: pluginWindow,
                provisioning,
              });
              if (typeof pluginWindow.once === 'function') {
                pluginWindow.once('closed', () => pendingRequests.delete(pluginWindow.id));
              }
            }

            pushMessage(
              pluginWindow,
              {
                deeplink: deeplink,
                origin_app_info: originInfo,
                provisioning_capability:
                  provisioning == null ? null : provisioning.capability.toString('hex'),
              },
              'VERUS_LOGIN_CONSENT_REQUEST'
            );
          },
          830,
          550,
          false
        );

        Promise.resolve(pluginStart).catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  };

  api.setPost(
    '/plugin/builtin/verus_login_consent_ui/request',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any, res: any) => {
      const {request} = req.body;
      const {app_id, builtin} = req.api_header;

      try {
        const retObj = {
          msg: 'success',
          result: await api.loginConsentUi.deeplink(request, {
            id: app_id,
            search_builtin: builtin,
          }),
        };

        res.send(JSON.stringify(retObj));
      } catch (e) {
        const retObj = {
          msg: 'error',
          result: (e as Error).message,
        };

        res.send(JSON.stringify(retObj));
      }
    }
  );

  return api;
};