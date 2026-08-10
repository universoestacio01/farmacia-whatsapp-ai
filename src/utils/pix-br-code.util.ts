interface PixBrCodeInput {
  key: string;
  amountCents: number;
  merchantName: string;
  merchantCity: string;
  txid: string;
}

function tlv(id: string, value: string) {
  const length = Buffer.byteLength(value, "utf8");

  if (length > 99) {
    throw new Error(`Campo Pix ${id} excede 99 caracteres.`);
  }

  return `${id}${String(length).padStart(2, "0")}${value}`;
}

function normalizeText(value: string, maxLength: number) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 $%*+\-./:]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeTxid(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.slice(0, 25) || "***";
}

function crc16Ccitt(payload: string) {
  let crc = 0xffff;

  for (const character of payload) {
    crc ^= character.charCodeAt(0) << 8;

    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        crc & 0x8000
          ? ((crc << 1) ^ 0x1021) & 0xffff
          : (crc << 1) & 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function generatePixBrCode(input: PixBrCodeInput) {
  const key = input.key.trim();

  if (!key) {
    throw new Error("Chave Pix nao configurada.");
  }

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Valor do Pix deve ser maior que zero.");
  }

  const merchantName = normalizeText(input.merchantName, 25);
  const merchantCity = normalizeText(input.merchantCity, 15);

  if (!merchantName || !merchantCity) {
    throw new Error("Nome e cidade do recebedor Pix sao obrigatorios.");
  }

  const merchantAccount = tlv("00", "BR.GOV.BCB.PIX") + tlv("01", key);
  const additionalData = tlv("05", normalizeTxid(input.txid));
  const amount = (input.amountCents / 100).toFixed(2);
  const payloadWithoutCrc =
    tlv("00", "01") +
    tlv("26", merchantAccount) +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", amount) +
    tlv("58", "BR") +
    tlv("59", merchantName) +
    tlv("60", merchantCity) +
    tlv("62", additionalData) +
    "6304";

  return `${payloadWithoutCrc}${crc16Ccitt(payloadWithoutCrc)}`;
}

export function isValidPixBrCodeCrc(payload: string) {
  if (!/^000201/.test(payload) || !/6304[0-9A-F]{4}$/i.test(payload)) {
    return false;
  }

  const payloadWithoutCrc = payload.slice(0, -4);
  return crc16Ccitt(payloadWithoutCrc) === payload.slice(-4).toUpperCase();
}

