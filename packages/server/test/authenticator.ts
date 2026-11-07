import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Encoder } from 'cbor-x';

const cbor = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false });

function bytes(value: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value) as Uint8Array<ArrayBuffer>;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derSignature(raw: Uint8Array): Uint8Array {
  const trim = (bytes: Uint8Array) => {
    let index = 0;
    while (index < bytes.length - 1 && bytes[index] === 0) index += 1;
    const sliced = bytes.slice(index);
    return (sliced[0] ?? 0) & 0x80 ? concat([new Uint8Array([0]), sliced]) : sliced;
  };
  const r = trim(raw.slice(0, 32));
  const s = trim(raw.slice(32));
  const body = concat([Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s]);
  return concat([Uint8Array.of(0x30, body.length), body]);
}

/** A real P-256 authenticator used only by tests. The server still verifies signatures. */
export class SoftwareAuthenticator {
  private keyPair: CryptoKeyPair | null = null;
  private credentialId = new Uint8Array();
  private rpId = 'localhost';
  counter = 0;

  async register(options: PublicKeyCredentialCreationOptionsJSON, origin: string): Promise<RegistrationResponseJSON> {
    this.rpId = options.rp.id ?? 'localhost';
    this.keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    this.credentialId = crypto.getRandomValues(new Uint8Array(16));
    this.counter = 0;
    const jwk = await crypto.subtle.exportKey('jwk', this.keyPair.publicKey);
    const coseKey = cbor.encode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, bytes(isoBase64URL.toBuffer(jwk.x ?? ''))],
        [-3, bytes(isoBase64URL.toBuffer(jwk.y ?? ''))],
      ]),
    );
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.rpId)));
    const authData = concat([
      rpIdHash,
      Uint8Array.of(0x45),
      Uint8Array.of(0, 0, 0, 0),
      new Uint8Array(16),
      Uint8Array.of(0, this.credentialId.length),
      this.credentialId,
      coseKey,
    ]);
    const attestationObject = cbor.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }),
    );
    const id = isoBase64URL.fromBuffer(bytes(this.credentialId));
    return {
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(bytes(clientDataJSON)),
        attestationObject: isoBase64URL.fromBuffer(bytes(attestationObject)),
        transports: ['internal'],
      },
    };
  }

  async authenticate(options: PublicKeyCredentialRequestOptionsJSON, origin: string, counter?: number, userVerified = true): Promise<AuthenticationResponseJSON> {
    if (!this.keyPair) throw new Error('authenticator_not_registered');
    this.counter = counter ?? this.counter + 1;
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.rpId ?? this.rpId)));
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, this.counter);
    const authData = concat([rpIdHash, Uint8Array.of(userVerified ? 0x05 : 0x01), count]);
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }),
    );
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keyPair.privateKey, bytes(concat([authData, clientDataHash]))),
    );
    const id = isoBase64URL.fromBuffer(bytes(this.credentialId));
    return {
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        authenticatorData: isoBase64URL.fromBuffer(bytes(authData)),
        clientDataJSON: isoBase64URL.fromBuffer(bytes(clientDataJSON)),
        signature: isoBase64URL.fromBuffer(bytes(derSignature(raw))),
      },
    };
  }
}
