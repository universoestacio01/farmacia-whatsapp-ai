function calculateCpfDigit(numbers: number[], factorStart: number) {
  const total = numbers.reduce(
    (sum, number, index) => sum + number * (factorStart - index),
    0,
  );
  const remainder = (total * 10) % 11;

  return remainder === 10 ? 0 : remainder;
}

export function isValidCpf(value: string): boolean {
  const cpf = value.replace(/\D/g, "");

  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) {
    return false;
  }

  const digits = cpf.split("").map(Number);
  const firstDigit = calculateCpfDigit(digits.slice(0, 9), 10);
  const secondDigit = calculateCpfDigit(digits.slice(0, 10), 11);

  return digits[9] === firstDigit && digits[10] === secondDigit;
}

export function generateValidCpf(): string {
  const digits = Array.from({ length: 9 }, () =>
    Math.floor(Math.random() * 10),
  );

  if (digits.every((digit) => digit === digits[0])) {
    digits[0] = (digits[0] + 1) % 10;
  }

  const firstDigit = calculateCpfDigit(digits, 10);
  const secondDigit = calculateCpfDigit([...digits, firstDigit], 11);

  return [...digits, firstDigit, secondDigit].join("");
}
