type JsonCredential = { toJSON?: () => unknown };

export async function createPasskey(options: unknown) {
  if (!window.PublicKeyCredential?.parseCreationOptionsFromJSON || !navigator.credentials) {
    throw new Error('This browser cannot create a passkey. A device PIN, fingerprint, or face unlock is used only where the phone offers it.');
  }
  const credential = (await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options as PublicKeyCredentialCreationOptionsJSON),
  })) as JsonCredential | null;
  if (!credential?.toJSON) throw new Error('The passkey was not created.');
  return credential.toJSON();
}

export async function usePasskey(options: unknown) {
  if (!window.PublicKeyCredential?.parseRequestOptionsFromJSON || !navigator.credentials) {
    throw new Error('This browser cannot use a passkey here.');
  }
  const credential = (await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options as PublicKeyCredentialRequestOptionsJSON),
  })) as JsonCredential | null;
  if (!credential?.toJSON) throw new Error('Unlock was cancelled.');
  return credential.toJSON();
}
