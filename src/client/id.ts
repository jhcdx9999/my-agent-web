const uuidFromRandomValues = (): string | undefined => {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    return undefined;
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
};

export const createClientId = (prefix: string): string => {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : uuidFromRandomValues();

  return `${prefix}_${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
};
