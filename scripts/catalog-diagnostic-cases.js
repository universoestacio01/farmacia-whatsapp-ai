const medicines = [
  "dipirona", "novalgina", "dorflex", "neosoro", "ibuprofeno",
  "alivium", "advil", "paracetamol", "tylenol", "buscopan",
  "buscopan composto", "luftal", "simeticona", "allegra", "loratadina",
  "desloratadina", "cetirizina", "polaramine", "benegrip", "cimegripe",
  "coristina d", "resfenol", "amoxicilina", "azitromicina", "cefalexina",
  "ciprofloxacino", "omeprazol", "pantoprazol", "losartana", "enalapril",
  "atenolol", "anlodipino", "hidroclorotiazida", "furosemida", "metformina",
  "glifage", "sinvastatina", "rosuvastatina", "plenance", "levotiroxina",
  "euthyrox", "puran t4", "venvanse", "clonazepam", "sertralina",
  "fluoxetina", "tadalafila", "viagra", "tamarine", "minancora",
];

const variations = [
  "dipirona 1g", "dipirona 1000mg", "venvanse 50mg", "venvanse 70mg",
  "dorflex 30 comprimidos", "allegra 6mg/ml", "allegra suspensao oral",
  "amoxicilina 250mg/5ml", "amoxicilina suspensao oral", "neosoro 0,5mg/ml",
  "euthyrox 50mcg", "puran t4 25mcg",
];

if (medicines.length !== 50 || new Set(medicines).size !== 50) {
  throw new Error("Diagnostic requires exactly 50 distinct medicine names");
}

module.exports = { medicines, variations };
