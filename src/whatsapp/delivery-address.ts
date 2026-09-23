export type AddressField = "cep" | "logradouro" | "bairro" | "localidade" | "uf" | "number";
export type DeliveryAddress = Partial<Record<AddressField, string>>;

const states = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));

export function parseAddressField(field: AddressField, input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().replace(/\s+/g, " ");
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (field === "cep") {
    if (!/^\d{5}-?\d{3}$/.test(value)) return null;
    const digits = value.replace("-", "");
    return /^(\d)\1{7}$/.test(digits) ? null : digits;
  }
  if (field === "uf") return states.has(value.toUpperCase()) ? value.toUpperCase() : null;
  if (field === "number") {
    if (/^(s\s*\/\s*n|sem numero)$/.test(normalized)) return "s/n";
    return /^\d{1,6}(?:[ /-]?[a-zA-Z0-9]{1,10})?$/.test(value) ? value : null;
  }
  if (value.length < 2 || value.length > 120 || /[<>\r\n]/.test(input)) return null;
  if (["nao", "sim", "nao sei", "sem", "ok", "nenhum", "nenhuma"].includes(normalized)) return null;
  return (value.match(/[a-zA-ZÀ-ÿ]/g)?.length ?? 0) >= 2 ? value : null;
}

export function missingAddressField(address: DeliveryAddress | null | undefined): AddressField | null {
  const fields: AddressField[] = ["cep", "logradouro", "bairro", "localidade", "uf", "number"];
  return fields.find((field) => !parseAddressField(field, address?.[field])) ?? null;
}

export function addressFieldPrompt(field: AddressField): string {
  const prompts: Record<AddressField, string> = {
    cep: "Qual é o CEP da entrega? Envie os 8 dígitos, com ou sem hífen.",
    logradouro: "Qual é o nome da rua ou estrada da entrega?",
    bairro: "Qual é o bairro ou a localidade rural da entrega?",
    localidade: "Em qual cidade será a entrega?",
    uf: "Qual é a sigla do estado? Por exemplo: RJ ou SC.",
    number: 'Qual é o número do endereço? Se não tiver, responda "s/n".',
  };
  return prompts[field];
}
