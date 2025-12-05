export interface ParsedDataUrl {
  mimeType: string;
  buffer: Buffer;
}

export function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }

  const meta = dataUrl.slice(5, commaIndex); // remove "data:"
  const base64Prefix = ";base64";

  if (!meta.endsWith(base64Prefix)) {
    return null;
  }

  const mimeType = meta.slice(0, -base64Prefix.length) || "application/octet-stream";
  const base64Data = dataUrl.slice(commaIndex + 1);

  try {
    const buffer = Buffer.from(base64Data, "base64");
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

