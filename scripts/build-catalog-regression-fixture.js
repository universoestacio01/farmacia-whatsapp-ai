// Extract only public product fields from the recorded audit. Never uses network/env.
const fs = require("node:fs");
const path = require("node:path");
const sources = [
  "live-catalog-50-2026-09-23T03-10-43-155Z.json",
  "live-catalog-50-2026-09-23T03-12-18-934Z.json",
];
const captures = new Map();
for (const source of sources) {
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, "../diagnostics", source), "utf8"));
  for (const request of report.requests) {
    if (!Array.isArray(request.body) || request.status >= 400) continue;
    captures.set(request.endpoint, {
      endpoint: request.endpoint, status: request.status, resources: request.resources,
      body: request.body.map((product) => ({
        productId: product.productId, productName: product.productName,
        brand: product.brand, categories: product.categories,
        "Princípio ativo": product["Princípio ativo"],
        items: product.items.map((item) => ({
          itemId: item.itemId, name: item.name, nameComplete: item.nameComplete,
          ean: item.ean, images: item.images?.map(({imageUrl}) => ({imageUrl})),
          sellers: item.sellers.map((seller) => ({
            sellerDefault: seller.sellerDefault,
            commertialOffer: {
              Price: seller.commertialOffer.Price,
              AvailableQuantity: seller.commertialOffer.AvailableQuantity,
              IsAvailable: seller.commertialOffer.IsAvailable,
            },
          })),
        })),
      })),
    });
  }
}
const destination = path.join(__dirname, "fixtures/catalog-2026-09-23.json");
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify({ sources, captures: [...captures.values()] }));
console.log(JSON.stringify({ destination, captures: captures.size, networkCalls: 0 }));
