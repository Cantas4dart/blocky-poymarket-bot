import * as crypto from "crypto";
import * as dotenv from "dotenv";

dotenv.config();

const ENC_PREFIX = "enc:v1";
const ENC_PREFIX_V2 = "enc:v2";

export function hasMasterKey(): boolean {
  const raw = process.env.MASTER_ENCRYPTION_KEY || "";
  return raw.length >= 16;
}

function getMasterSecret(): string {
  const raw = process.env.MASTER_ENCRYPTION_KEY || "";
  if (!raw || raw.length < 16) {
    throw new Error("MASTER_ENCRYPTION_KEY is missing or too short. Set a strong secret in .env.");
  }
  return raw;
}

function getLegacyMasterKey(): Buffer {
  return crypto.createHash("sha256").update(getMasterSecret(), "utf8").digest();
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && (
    value.startsWith(`${ENC_PREFIX}:`) ||
    value.startsWith(`${ENC_PREFIX_V2}:`)
  );
}

function deriveV2Key(salt: Buffer): Buffer {
  return crypto.scryptSync(getMasterSecret(), salt, 32);
}

export function encryptSecret(plainText: string): string {
  const salt = crypto.randomBytes(16);
  const key = deriveV2Key(salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX_V2}:${salt.toString("base64")}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  if (!isEncryptedSecret(value)) {
    return value;
  }

  if (value.startsWith(`${ENC_PREFIX_V2}:`)) {
    const [, , saltB64, ivB64, tagB64, dataB64] = value.split(":");
    const key = deriveV2Key(Buffer.from(saltB64, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final()
    ]);
    return decrypted.toString("utf8");
  }

  const [, , ivB64, tagB64, dataB64] = value.split(":");
  const key = getLegacyMasterKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}
