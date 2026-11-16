// Intl.NumberFormat only (pt-BR): no DateTimeFormat, no Collator
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const prices = [1234.5, 99.9, 0.07];
for (const p of prices) console.log(brl.format(p));
