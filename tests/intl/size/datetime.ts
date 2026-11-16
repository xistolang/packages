// Intl.DateTimeFormat only (pt-BR): no NumberFormat, no Collator
const dia = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "America/Sao_Paulo" });
console.log(dia.format(new Date(Date.UTC(2026, 2, 5, 14, 7, 9))));
