import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

function base64Decode(value: string) {
  return Buffer.from(value, "base64");
}

function base64Encode(value: Buffer) {
  return value.toString("base64");
}

export function genNonce() {
  const millis = Date.now();
  const randomPart = randomBytes(8);
  const timePartValue = BigInt(Math.floor(millis / 60_000));
  let hex = timePartValue.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  const timePart = Buffer.from(hex, "hex");
  return base64Encode(Buffer.concat([randomPart, timePart]));
}

export function getSignedNonce(ssecurity: string, nonce: string) {
  const hash = createHash("sha256");
  hash.update(base64Decode(ssecurity));
  hash.update(base64Decode(nonce));
  return base64Encode(hash.digest());
}

export function genEncSignature(
  uri: string,
  method: string,
  signedNonce: string,
  params: Record<string, string>,
) {
  const signatureParts = [method.toUpperCase(), uri];
  for (const [key, value] of Object.entries(params)) {
    signatureParts.push(`${key}=${value}`);
  }
  signatureParts.push(signedNonce);
  return base64Encode(
    createHash("sha1").update(signatureParts.join("&"), "utf8").digest(),
  );
}

class Rc4Cipher {
  private readonly s = Array.from({ length: 256 }, (_, index) => index);
  private i = 0;
  private j = 0;

  constructor(key: Buffer) {
    let j = 0;
    for (let i = 0; i < 256; i += 1) {
      j = (j + this.s[i]! + key[i % key.length]!) & 0xff;
      [this.s[i], this.s[j]] = [this.s[j]!, this.s[i]!];
    }
  }

  transform(payload: Buffer) {
    const output = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      this.i = (this.i + 1) & 0xff;
      this.j = (this.j + this.s[this.i]!) & 0xff;
      [this.s[this.i], this.s[this.j]] = [
        this.s[this.j]!,
        this.s[this.i]!,
      ];
      const keyByte = this.s[(this.s[this.i]! + this.s[this.j]!) & 0xff]!;
      output[index] = payload[index]! ^ keyByte;
    }
    return output;
  }
}

function createRc4Cipher(password: string) {
  const cipher = new Rc4Cipher(base64Decode(password));
  cipher.transform(Buffer.alloc(1024));
  return cipher;
}

function decodeUtf8OrGunzip(payload: Buffer) {
  if (payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
    return gunzipSync(payload).toString("utf8");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return gunzipSync(payload).toString("utf8");
  }
}

export function encryptRc4(password: string, payload: string) {
  const cipher = createRc4Cipher(password);
  return base64Encode(cipher.transform(Buffer.from(payload, "utf8")));
}

export function decryptRc4(password: string, payload: string) {
  const cipher = createRc4Cipher(password);
  return cipher.transform(base64Decode(payload));
}

export function decryptEncryptedPayload(
  ssecurity: string,
  nonce: string,
  payload: string,
) {
  const decrypted = decryptRc4(getSignedNonce(ssecurity, nonce), payload);
  return decodeUtf8OrGunzip(decrypted);
}

export function generateEncryptedParams(
  uri: string,
  method: string,
  signedNonce: string,
  nonce: string,
  params: Record<string, string>,
  ssecurity: string,
) {
  const encryptedParams: Record<string, string> = {
    ...params,
  };
  encryptedParams.rc4_hash__ = genEncSignature(
    uri,
    method,
    signedNonce,
    encryptedParams,
  );

  for (const [key, value] of Object.entries(encryptedParams)) {
    encryptedParams[key] = encryptRc4(signedNonce, value);
  }

  encryptedParams.signature = genEncSignature(
    uri,
    method,
    signedNonce,
    encryptedParams,
  );
  encryptedParams.ssecurity = ssecurity;
  encryptedParams._nonce = nonce;
  return encryptedParams;
}
